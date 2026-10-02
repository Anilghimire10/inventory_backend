import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdjustmentReason,
  Prisma,
  PrismaClient,
  SerialStatus,
  StockMovementType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AdjustStockDto, SetReorderLevelDto, WriteOffExpiredDto } from './dto/adjust-stock.dto';
import { expiredCutoff, isExpired, soonCutoff } from '../common/expiry';
import { readStockRow, type StockRow } from './stock-import';
import { StockTakeDto, TransferStockDto } from './dto/stock-ops.dto';
import {
  ExpiringDto,
  QueryMovementsDto,
  QuerySerialsDto,
  QueryStockDto,
} from './dto/query-inventory.dto';
import { paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';
import { allowsFraction } from '../common/units';

/** Quantities are numeric(12,3); keep JS float arithmetic on that grid. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Where a serialised unit is, in words, for error messages and the till. */
function describeSerial(r: {
  status: SerialStatus;
  store?: { name: string } | null;
  sale?: { receiptNo: string } | null;
}): string {
  switch (r.status) {
    case SerialStatus.IN_STOCK:
      return r.store ? `in stock at ${r.store.name}` : 'in stock';
    case SerialStatus.SOLD:
      return r.sale ? `sold on ${r.sale.receiptNo}` : 'sold';
    case SerialStatus.RETURNED_TO_SUPPLIER:
      return 'returned to the supplier';
    case SerialStatus.DAMAGED:
      return 'written off as damaged';
    case SerialStatus.LOST:
      return 'written off as lost';
  }
}

/** What a serialised unit removed by hand becomes. */
function serialStatusFor(reason: AdjustmentReason): 'DAMAGED' | 'LOST' {
  return reason === AdjustmentReason.DAMAGE || reason === AdjustmentReason.EXPIRED ? 'DAMAGED' : 'LOST';
}

const REASON_NOTE: Record<AdjustmentReason, string> = {
  DAMAGE: 'Damaged',
  THEFT: 'Stolen or lost',
  COUNT_CORRECTION: 'Count correction',
  EXPIRED: 'Expired',
  OTHER: 'Removed by hand',
};

/** A Prisma client or an active transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

export interface MovementInput {
  businessId: string;
  storeId: string;
  productId: string;
  type: StockMovementType;
  /** Signed: positive adds stock, negative removes it. */
  quantity: number;
  userId?: string | null;
  reason?: AdjustmentReason | null;
  note?: string | null;
  reference?: string | null;
}

@Injectable()
export class InventoryService {
  constructor(private prisma: PrismaService) {}

  /**
   * Discrete goods (pcs, box, pair) must move in whole numbers; measured ones
   * (kg, l, m) may move in fractions. Enforced here rather than in each DTO
   * because every stock change in the app routes through applyMovement or
   * applyMovementsBatch, so sales, purchases, transfers, adjustments and stock
   * takes all inherit it from one place.
   *
   * Costs nothing on the common path: a movement of whole units is valid
   * whatever the product's unit is, so the lookup only happens once a fraction
   * actually shows up.
   */
  private async assertFractionsAllowed(db: Db, inputs: MovementInput[]) {
    const fractional = inputs.filter(
      (i) => !Number.isInteger(round3(i.quantity)),
    );
    if (fractional.length === 0) return;

    const products = await db.product.findMany({
      where: { id: { in: [...new Set(fractional.map((i) => i.productId))] } },
      select: { id: true, name: true, unit: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    for (const inp of fractional) {
      const product = byId.get(inp.productId);
      if (product && !allowsFraction(product.unit)) {
        throw new BadRequestException(
          `"${product.name}" is sold by the ${product.unit} — its quantity must be a whole number`,
        );
      }
    }
  }

  /**
   * The single source of truth for every stock change. Updates the
   * per-store StockItem balance and writes an audit StockMovement row.
   * Accepts a transaction client so callers (sales, purchases) can make
   * the stock change part of their own atomic operation.
   */
  async applyMovement(
    db: Db,
    input: MovementInput,
    opts: { allowNegative?: boolean } = {},
  ) {
    const { businessId, storeId, productId, quantity } = input;
    const allowNegative = opts.allowNegative ?? false;
    await this.assertFractionsAllowed(db, [input]);

    // Make sure the row exists (upsert is atomic against concurrent
    // creates -- the DB unique constraint on storeId+productId resolves
    // the race, the "loser" just no-ops via `update: {}`).
    await db.stockItem.upsert({
      where: { storeId_productId: { storeId, productId } },
      create: { businessId, storeId, productId, quantity: 0 },
      update: {},
    });

    // Atomic guarded increment: the WHERE clause is evaluated against the
    // row's live, locked value at UPDATE time, not a value read earlier in
    // JS. This closes both the lost-update race (two concurrent movements
    // on the same row silently dropping one) and the overselling race (two
    // concurrent sales both passing a stale insufficient-stock check).
    // Quantities are numeric(12,3) (weighed goods), so the delta is bound as
    // text and cast to numeric: a float8 parameter would round-trip 0.1-style
    // values through binary floating point before the DB ever saw them.
    const delta = String(round3(quantity));
    const rows = await db.$queryRaw<{ quantity: Prisma.Decimal }[]>`
      UPDATE "StockItem"
      SET quantity = quantity + ${delta}::numeric
      WHERE "storeId" = ${storeId} AND "productId" = ${productId}
        AND (${allowNegative} OR quantity + ${delta}::numeric >= 0)
      RETURNING quantity
    `;
    if (rows.length === 0) {
      const existing = await db.stockItem.findUnique({
        where: { storeId_productId: { storeId, productId } },
      });
      throw new BadRequestException(
        `Insufficient stock (have ${Number(existing?.quantity ?? 0)}, need ${-quantity})`,
      );
    }

    await db.stockMovement.create({
      data: {
        businessId,
        storeId,
        productId,
        userId: input.userId ?? null,
        type: input.type,
        quantity: delta,
        reason: input.reason ?? null,
        note: input.note ?? null,
        reference: input.reference ?? null,
      },
    });

    return Number(rows[0].quantity);
  }

  /**
   * Same as applyMovement, but for many movements in one shot — used by
   * checkout/returns so an N-line sale costs a handful of round trips
   * instead of 3*N (one read + one bulk write instead of a read+upsert+insert
   * per line, which dominates latency when the DB isn't co-located with the app).
   */
  async applyMovementsBatch(
    db: Db,
    inputs: MovementInput[],
    opts: { allowNegative?: boolean } = {},
  ) {
    if (inputs.length === 0) return;
    await this.assertFractionsAllowed(db, inputs);

    const keyOf = (storeId: string, productId: string) => `${storeId}:${productId}`;

    // Net delta per (store, product) -- a sale can list the same product on
    // more than one line, so sum them before touching the DB.
    const groups = new Map<
      string,
      { businessId: string; storeId: string; productId: string; delta: number }
    >();
    for (const inp of inputs) {
      const k = keyOf(inp.storeId, inp.productId);
      const g = groups.get(k);
      if (g) g.delta = round3(g.delta + inp.quantity);
      else
        groups.set(k, {
          businessId: inp.businessId,
          storeId: inp.storeId,
          productId: inp.productId,
          delta: inp.quantity,
        });
    }
    if (groups.size === 0) return;
    const allowNegative = opts.allowNegative ?? false;
    const values = [...groups.values()];

    // Make sure every row exists first. Safe under concurrency: the unique
    // constraint on (storeId, productId) resolves a racing create, and
    // skipDuplicates just drops the loser's insert rather than erroring.
    await db.stockItem.createMany({
      data: values.map((g) => ({
        businessId: g.businessId,
        storeId: g.storeId,
        productId: g.productId,
        quantity: 0,
      })),
      skipDuplicates: true,
    });

    // Atomic bulk guarded increment, matched by (storeId, productId) rather
    // than a previously-read id. Like applyMovement, the guard is evaluated
    // against each row's live, locked value -- immune to lost updates and
    // to overselling from a stale read, even across concurrent batches.
    const storeIds = values.map((g) => g.storeId);
    const productIds = values.map((g) => g.productId);
    // Deltas travel as text and are cast to numeric in SQL -- see applyMovement.
    const deltas = values.map((g) => String(round3(g.delta)));
    const updated = await db.$queryRaw<
      { storeId: string; productId: string; quantity: Prisma.Decimal }[]
    >`
      UPDATE "StockItem" AS si
      SET quantity = si.quantity + v.delta::numeric
      FROM (
        SELECT * FROM UNNEST(${storeIds}::text[], ${productIds}::text[], ${deltas}::text[])
      ) AS v(store_id, product_id, delta)
      WHERE si."storeId" = v.store_id AND si."productId" = v.product_id
        AND (${allowNegative} OR si.quantity + v.delta::numeric >= 0)
      RETURNING si."storeId" AS "storeId", si."productId" AS "productId", si.quantity
    `;

    if (updated.length < values.length) {
      const okKeys = new Set(updated.map((u) => keyOf(u.storeId, u.productId)));
      const failed = values.find((g) => !okKeys.has(keyOf(g.storeId, g.productId)))!;
      throw new BadRequestException(
        `Insufficient stock for product ${failed.productId}`,
      );
    }

    await db.stockMovement.createMany({
      data: inputs.map((inp) => ({
        businessId: inp.businessId,
        storeId: inp.storeId,
        productId: inp.productId,
        userId: inp.userId ?? null,
        type: inp.type,
        quantity: String(round3(inp.quantity)),
        reason: inp.reason ?? null,
        note: inp.note ?? null,
        reference: inp.reference ?? null,
      })),
    });
  }

  /**
   * Reduce batch quantities oldest-expiry-first (First-Expired-First-Out)
   * for every batch-tracked line in one shot: one read for all products'
   * batches, then a single bulk write for every batch touched, instead of
   * a read + N updates per line.
   *
   * Batches already past their date go last. Taken strictly by date they
   * went first, so selling one unit of a product with an expired batch on
   * the shelf recorded the expired unit as the one sold -- and the good
   * stock as what was left.
   *
   * Lives here rather than in SalesService because a sale is not the only
   * way stock leaves the shelf: an adjustment or a stock take that removes
   * stock has to draw the batches down too, or they drift above the shelf
   * and the Expiring list counts stock that isn't there.
   */
  async consumeBatchesFEFO(
    db: Db,
    storeId: string,
    items: { productId: string; quantity: number }[],
  ) {
    if (items.length === 0) return;
    const productIds = items.map((i) => i.productId);
    const batches = await db.batch.findMany({
      where: { storeId, productId: { in: productIds }, quantity: { gt: 0 } },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });
    // Stable sort: in-date (and undated) batches keep their order, expired
    // ones move behind them.
    const cutoff = expiredCutoff();
    batches.sort(
      (a, b) =>
        Number(!!a.expiryDate && a.expiryDate <= cutoff) - Number(!!b.expiryDate && b.expiryDate <= cutoff),
    );
    const batchesByProduct = new Map<string, typeof batches>();
    for (const b of batches) {
      const arr = batchesByProduct.get(b.productId);
      if (arr) arr.push(b);
      else batchesByProduct.set(b.productId, [b]);
    }

    // Final quantity per batch (not a delta) -- a product can appear on more
    // than one line, so we keep consuming the same in-memory batch list
    // across lines and only record each batch's *last* resulting quantity.
    const finalQtyByBatchId = new Map<string, number>();
    for (const item of items) {
      let remaining = item.quantity;
      const productBatches = batchesByProduct.get(item.productId) ?? [];
      for (const batch of productBatches) {
        if (remaining <= 0) break;
        const available = Number(batch.quantity);
        if (available <= 0) continue;
        const take = round3(Math.min(available, remaining));
        const left = round3(available - take);
        batch.quantity = new Prisma.Decimal(left);
        finalQtyByBatchId.set(batch.id, left);
        remaining = round3(remaining - take);
      }
      // If batches don't cover it, StockItem remains the source of truth; we
      // don't block the sale on batch bookkeeping.
    }

    if (finalQtyByBatchId.size === 0) return;
    const updateIds = [...finalQtyByBatchId.keys()];
    const updateQtys = updateIds.map((id) => String(finalQtyByBatchId.get(id)!));
    await db.$executeRaw`
      UPDATE "Batch" AS b
      SET quantity = v.qty::numeric
      FROM (SELECT * FROM UNNEST(${updateIds}::text[], ${updateQtys}::text[])) AS v(id, qty)
      WHERE b.id = v.id
    `;
  }

  /**
   * Put stock into a batch, merging into the one with the same natural key
   * (store, product, batch number, expiry) rather than forking a duplicate.
   * Undated stock goes into an undated batch: it still has to be in *a*
   * batch, or the batches stop adding up to the shelf.
   */
  async addToBatch(
    db: Db,
    input: {
      businessId: string;
      storeId: string;
      productId: string;
      quantity: number | Prisma.Decimal;
      batchNumber: string | null;
      expiryDate: Date | null;
      costPrice?: number | Prisma.Decimal | null;
    },
  ) {
    const existing = await db.batch.findFirst({
      where: {
        storeId: input.storeId,
        productId: input.productId,
        batchNumber: input.batchNumber,
        expiryDate: input.expiryDate,
      },
      select: { id: true },
    });
    const quantity = String(round3(Number(input.quantity)));
    if (existing) {
      await db.batch.update({
        where: { id: existing.id },
        data: {
          quantity: { increment: quantity },
          ...(input.costPrice != null ? { costPrice: input.costPrice } : {}),
        },
      });
    } else {
      await db.batch.create({
        data: {
          businessId: input.businessId,
          storeId: input.storeId,
          productId: input.productId,
          batchNumber: input.batchNumber,
          expiryDate: input.expiryDate,
          quantity,
          costPrice: input.costPrice ?? null,
        },
      });
    }
  }

  /**
   * The batch side of a stock change made by hand (an adjustment, a stock
   * take): for batch-tracked products, stock removed comes out of the
   * batches first-expiry-first, as a sale's does, and stock added goes into
   * the batch given, or an undated one. Other products have no batches to
   * keep in step and are left alone.
   */
  async syncBatches(
    db: Db,
    businessId: string,
    storeId: string,
    changes: {
      productId: string;
      quantity: number;
      batchNumber?: string | null;
      expiryDate?: Date | null;
    }[],
  ) {
    const moved = changes.filter((c) => c.quantity !== 0);
    if (moved.length === 0) return;
    const tracked = new Set(
      (
        await db.product.findMany({
          where: { id: { in: [...new Set(moved.map((c) => c.productId))] }, trackBatches: true },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    const ours = moved.filter((c) => tracked.has(c.productId));
    await this.consumeBatchesFEFO(
      db,
      storeId,
      ours.filter((c) => c.quantity < 0).map((c) => ({ productId: c.productId, quantity: -c.quantity })),
    );
    for (const c of ours.filter((c) => c.quantity > 0)) {
      await this.addToBatch(db, {
        businessId,
        storeId,
        productId: c.productId,
        quantity: c.quantity,
        batchNumber: c.batchNumber ?? null,
        expiryDate: c.expiryDate ?? null,
      });
    }
  }

  /**
   * A manual stock change (damage, count correction, etc.). For a serialised
   * product the units must be named: added ones go on file as in stock,
   * removed ones come off it -- DAMAGED for damage or expiry, LOST otherwise
   * -- so the serial list and the count move together. For a batch-tracked
   * one the batches move with it: removed stock comes out first-expiry-first,
   * added stock goes into the batch given (or an undated one).
   */
  async adjust(businessId: string, userId: string, dto: AdjustStockDto) {
    await this.assertStoreAndProduct(businessId, dto.storeId, dto.productId);
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      select: { name: true, trackSerials: true, trackBatches: true },
    });
    const serials = InventoryService.checkSerials(
      { name: product!.name, trackSerials: product!.trackSerials },
      Math.abs(dto.delta),
      dto.serials,
    );
    if (dto.batchNumber || dto.expiryDate) {
      if (!product!.trackBatches) {
        throw new BadRequestException(`${product!.name} isn't tracked by batch — leave Batch and Expiry blank`);
      }
      if (dto.delta < 0) {
        throw new BadRequestException('Stock taken out comes from the earliest-expiring batch — leave Batch and Expiry blank');
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const moved = await this.applyMovement(tx, {
        businessId,
        storeId: dto.storeId,
        productId: dto.productId,
        type: StockMovementType.ADJUSTMENT,
        quantity: dto.delta,
        reason: dto.reason,
        note: dto.note,
        userId,
      });
      await this.syncBatches(tx, businessId, dto.storeId, [
        {
          productId: dto.productId,
          quantity: dto.delta,
          batchNumber: dto.batchNumber?.trim() || null,
          expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
        },
      ]);
      if (serials.length) {
        const unit = { businessId, storeId: dto.storeId, productId: dto.productId, serials };
        if (dto.delta > 0) {
          await this.receiveSerials(tx, { ...unit, note: dto.note ?? 'Added by hand', allowLost: true });
        } else {
          await this.removeSerials(tx, {
            ...unit,
            status: serialStatusFor(dto.reason),
            note: dto.note ?? REASON_NOTE[dto.reason],
          });
        }
      }
      return moved;
    }, TX_OPTS);
  }

  /**
   * Opening stock from a spreadsheet: each row adds a quantity of one product
   * at one branch -- with its batch and expiry, and its serial numbers for a
   * serialised product -- the way stock counted on day one gets into the app.
   *
   * Everything is checked first (`dryRun` stops there): the product, the
   * branch, whole units where they must be, one serial per unit and none
   * already on file. Then each good row is posted on its own, so one row
   * failing doesn't lose the rest; failures come back by row.
   */
  async importStock(
    businessId: string,
    userId: string,
    items: Record<string, unknown>[],
    opts: { dryRun?: boolean; storeId?: string } = {},
  ) {
    if (items.length > 5000) throw new BadRequestException('Import is limited to 5000 rows at a time');
    const errors: { row: number; error: string }[] = [];
    const stores = await this.prisma.store.findMany({ where: { businessId }, select: { id: true, name: true } });
    const rows: { row: number; data: StockRow }[] = [];
    items.forEach((it, i) => {
      try {
        rows.push({ row: i + 1, data: readStockRow(it) });
      } catch (e) {
        errors.push({ row: i + 1, error: (e as Error).message });
      }
    });

    // Products, one query: by SKU, barcode or exact name.
    const pick = (f: (d: StockRow) => string | null) => [...new Set(rows.map((r) => f(r.data)).filter((v): v is string => !!v))];
    const skus = pick((d) => d.sku);
    const barcodes = pick((d) => (d.sku ? null : d.barcode));
    const names = pick((d) => (d.sku || d.barcode ? null : d.name));
    const products = await this.prisma.product.findMany({
      where: {
        businessId,
        OR: [
          ...(skus.length ? [{ sku: { in: skus } }] : []),
          ...(barcodes.length ? [{ barcode: { in: barcodes } }] : []),
          ...(names.length ? [{ name: { in: names, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: { id: true, name: true, sku: true, barcode: true, unit: true, trackBatches: true, trackSerials: true, costPrice: true },
    });
    const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku!, p]));
    const byBarcode = new Map(products.filter((p) => p.barcode).map((p) => [p.barcode!, p]));
    const byName = new Map<string, typeof products>();
    for (const p of products) {
      const k = p.name.toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), p]);
    }
    const storeByName = new Map(stores.map((s) => [s.name.toLowerCase(), s.id]));
    const defaultStore = opts.storeId && stores.some((s) => s.id === opts.storeId) ? opts.storeId : stores.length === 1 ? stores[0].id : null;

    // Serials already on file, and repeated within the file.
    const allSerials = rows.flatMap((r) => r.data.serials);
    const onFile = allSerials.length
      ? new Set(
          (
            await this.prisma.serial.findMany({
              where: { businessId, serialNumber: { in: allSerials } },
              select: { serialNumber: true },
            })
          ).map((s) => s.serialNumber),
        )
      : new Set<string>();
    const seenSerials = new Set<string>();

    type Plan = {
      row: number;
      product: (typeof products)[number];
      storeId: string;
      quantity: number;
      cost: number | null;
      batchNumber: string | null;
      expiryDate: Date | null;
      serials: string[];
    };
    const plans: Plan[] = [];
    for (const { row, data: d } of rows) {
      try {
        const product = d.sku
          ? bySku.get(d.sku)
          : d.barcode
            ? byBarcode.get(d.barcode)
            : (() => {
                const found = byName.get(d.name!.toLowerCase()) ?? [];
                if (found.length > 1) throw new Error(`More than one product is called "${d.name}" — use its SKU`);
                return found[0];
              })();
        if (!product) throw new Error(`No product with ${d.sku ? `SKU "${d.sku}"` : d.barcode ? `barcode "${d.barcode}"` : `the name "${d.name}"`}`);

        const storeId = d.store ? storeByName.get(d.store.toLowerCase()) : defaultStore;
        if (!storeId) {
          throw new Error(d.store ? `No branch called "${d.store}"` : 'Say which branch (Store column), or pick one before importing');
        }
        if (!allowsFraction(product.unit) && !Number.isInteger(d.quantity)) {
          throw new Error(`${product.name} is counted in whole ${product.unit}; quantity ${d.quantity} isn't`);
        }
        if (product.trackSerials) {
          InventoryService.checkSerials(product, d.quantity, d.serials);
          for (const n of d.serials) {
            if (onFile.has(n)) throw new Error(`Serial "${n}" is already on file`);
            if (seenSerials.has(n)) throw new Error(`Serial "${n}" appears twice in the file`);
          }
          d.serials.forEach((n) => seenSerials.add(n));
        } else if (d.serials.length) {
          throw new Error(`${product.name} isn't tracked by serial number — leave Serials blank`);
        }
        if (!product.trackBatches && d.batchNumber) {
          throw new Error(`${product.name} isn't tracked by batch — leave Batch blank`);
        }
        plans.push({ row, product, storeId, quantity: d.quantity, cost: d.cost, batchNumber: d.batchNumber, expiryDate: d.expiryDate, serials: d.serials });
      } catch (e) {
        errors.push({ row, error: (e as Error).message });
      }
    }

    const units = round3(plans.reduce((n, p) => n + p.quantity, 0));
    if (opts.dryRun) {
      errors.sort((a, b) => a.row - b.row);
      return { dryRun: true, rows: plans.length, units, errors };
    }

    let imported = 0;
    for (const p of plans) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.applyMovement(tx, {
            businessId,
            storeId: p.storeId,
            productId: p.product.id,
            type: StockMovementType.ADJUSTMENT,
            quantity: p.quantity,
            reason: AdjustmentReason.OTHER,
            note: 'Opening stock (import)',
            userId,
          });
          if (p.product.trackBatches) {
            await tx.batch.create({
              data: {
                businessId,
                storeId: p.storeId,
                productId: p.product.id,
                batchNumber: p.batchNumber,
                expiryDate: p.expiryDate,
                quantity: String(p.quantity),
                costPrice: p.cost ?? undefined,
              },
            });
          }
          if (p.serials.length) {
            await this.receiveSerials(tx, {
              businessId,
              storeId: p.storeId,
              productId: p.product.id,
              serials: p.serials,
              note: 'Opening stock',
            });
          }
          // A product with no cost on file takes the one in the sheet, so
          // its profit isn't counted as the whole sale price; one without
          // batches keeps an expiry date on the product itself.
          const productUpdate = {
            ...(p.cost != null && Number(p.product.costPrice) === 0 ? { costPrice: p.cost } : {}),
            ...(!p.product.trackBatches && p.expiryDate ? { expiryDate: p.expiryDate } : {}),
          };
          if (Object.keys(productUpdate).length) {
            await tx.product.update({ where: { id: p.product.id }, data: productUpdate });
          }
        }, TX_OPTS);
        imported++;
      } catch (e) {
        errors.push({ row: p.row, error: (e as Error).message });
      }
    }
    errors.sort((a, b) => a.row - b.row);
    return { imported, units, errors };
  }

  async setReorderLevel(businessId: string, dto: SetReorderLevelDto) {
    await this.assertStoreAndProduct(businessId, dto.storeId, dto.productId);
    return this.prisma.stockItem.upsert({
      where: {
        storeId_productId: { storeId: dto.storeId, productId: dto.productId },
      },
      create: {
        businessId,
        storeId: dto.storeId,
        productId: dto.productId,
        reorderLevel: dto.reorderLevel,
      },
      update: { reorderLevel: dto.reorderLevel },
    });
  }

  async listStock(businessId: string, q: QueryStockDto) {
    const where: Prisma.StockItemWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.search
        ? { product: { name: { contains: q.search, mode: 'insensitive' } } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.stockItem.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          product: {
            select: { id: true, name: true, sku: true, unit: true, reorderLevel: true, trackSerials: true, trackBatches: true },
          },
          store: { select: { id: true, name: true } },
        },
        orderBy: { product: { name: 'asc' } },
      }),
      this.prisma.stockItem.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  /**
   * Items at or below their reorder level. Effective level is the
   * per-store override when set, otherwise the product default.
   */
  /**
   * Stock at or below its reorder point.
   *
   * The filter runs in SQL, not in JS. This used to `findMany` **every**
   * StockItem row for the business -- with a product and store join on each --
   * and then drop the ones above their reorder level in Node. It is the hot
   * path behind the notification sync, the dashboard, analytics, the daily
   * digest and the reorder suggestions, so it read the whole table several
   * times a minute to return a handful of rows.
   *
   * The effective level is the per-store override when non-zero, otherwise the
   * product default -- `COALESCE(NULLIF(si."reorderLevel", 0), p."reorderLevel")`,
   * which is exactly what `it.reorderLevel || it.product.reorderLevel` meant.
   *
   * The nested `product`/`store` shape is rebuilt below rather than flattened:
   * six call sites and the `GET /inventory/low-stock` response read it, and the
   * win here is the SQL filter, not the response shape.
   */
  async lowStock(businessId: string, storeId?: string) {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        businessId: string;
        storeId: string;
        productId: string;
        quantity: Prisma.Decimal;
        reorderLevel: number;
        updatedAt: Date;
        effectiveReorderLevel: number;
        productName: string;
        productSku: string | null;
        productUnit: string;
        productCostPrice: Prisma.Decimal;
        productReorderLevel: number;
        storeName: string;
      }[]
    >`
      SELECT si.id, si."businessId", si."storeId", si."productId",
             si.quantity, si."reorderLevel", si."updatedAt",
             COALESCE(NULLIF(si."reorderLevel", 0), p."reorderLevel")
               AS "effectiveReorderLevel",
             p.name        AS "productName",
             p.sku         AS "productSku",
             p.unit        AS "productUnit",
             p."costPrice" AS "productCostPrice",
             p."reorderLevel" AS "productReorderLevel",
             s.name        AS "storeName"
      FROM "StockItem" si
      JOIN "Product" p ON p.id = si."productId"
      JOIN "Store"   s ON s.id = si."storeId"
      WHERE si."businessId" = ${businessId}
        ${storeId ? Prisma.sql`AND si."storeId" = ${storeId}` : Prisma.empty}
        -- Nothing to reorder for a deleted product, a closed branch, or a
        -- style whose stock lives on its variants. Without these, each one
        -- alerted forever (bell, dashboard, daily email) and "create reorder
        -- drafts" raised purchase orders for goods the shop had retired.
        AND p."isActive"
        AND s."isActive"
        AND NOT EXISTS (SELECT 1 FROM "Product" v WHERE v."parentId" = p.id)
        AND COALESCE(NULLIF(si."reorderLevel", 0), p."reorderLevel") > 0
        AND si.quantity <= COALESCE(NULLIF(si."reorderLevel", 0), p."reorderLevel")
      ORDER BY p.name ASC
    `;

    return rows.map((r) => ({
      id: r.id,
      businessId: r.businessId,
      storeId: r.storeId,
      productId: r.productId,
      quantity: r.quantity,
      reorderLevel: r.reorderLevel,
      updatedAt: r.updatedAt,
      effectiveReorderLevel: Number(r.effectiveReorderLevel),
      product: {
        id: r.productId,
        name: r.productName,
        sku: r.productSku,
        unit: r.productUnit,
        costPrice: r.productCostPrice,
        reorderLevel: r.productReorderLevel,
      },
      store: { id: r.storeId, name: r.storeName },
    }));
  }

  // ---- Serial / IMEI tracking ----
  //
  // Serial rows say *which* units are on the shelf; StockItem still owns the
  // count. The two are kept in step on every path that moves stock: receive,
  // sell, both kinds of return, transfer, manual adjustment and stock take.
  // The last two used to move the count without naming units, so a unit
  // added by hand could never be sold (it had no serial on file) and one
  // removed by hand stayed listed as in stock.

  /**
   * Validate the serials supplied for one line against its quantity and hand
   * back the cleaned list. A product that is not serialised must carry none.
   */
  static checkSerials(
    product: { name: string; trackSerials: boolean },
    quantity: number,
    serials: string[] | undefined,
  ): string[] {
    const cleaned = (serials ?? []).map((v) => v.trim()).filter(Boolean);
    if (!product.trackSerials) {
      if (cleaned.length) {
        throw new BadRequestException(
          `"${product.name}" is not tracked by serial number`,
        );
      }
      return [];
    }
    if (!Number.isInteger(quantity)) {
      throw new BadRequestException(
        `"${product.name}" is sold by the unit — its quantity must be a whole number`,
      );
    }
    if (new Set(cleaned).size !== cleaned.length) {
      throw new BadRequestException(
        `Duplicate serial numbers for "${product.name}"`,
      );
    }
    if (cleaned.length !== quantity) {
      throw new BadRequestException(
        `"${product.name}" needs ${quantity} serial number(s), got ${cleaned.length}`,
      );
    }
    return cleaned;
  }

  /**
   * Book units into stock: received on a purchase, or added by hand (an
   * adjustment or a unit found at a stock take). Rejects a serial already on
   * file unless it is one that may come back: returned to the supplier (a
   * repaired swap, a re-delivery) or -- for stock added by hand -- one
   * written off as lost and since found.
   */
  async receiveSerials(
    db: Db,
    input: {
      businessId: string;
      storeId: string;
      productId: string;
      purchaseId?: string | null;
      serials: string[];
      note?: string | null;
      /** Also bring back units marked LOST. Hand-added stock only. */
      allowLost?: boolean;
    },
  ) {
    if (!input.serials.length) return;
    const known = await db.serial.findMany({
      where: {
        businessId: input.businessId,
        serialNumber: { in: input.serials },
      },
      select: { id: true, serialNumber: true, status: true, store: { select: { name: true } } },
    });
    const mayReturn = (st: SerialStatus) =>
      st === SerialStatus.RETURNED_TO_SUPPLIER || (!!input.allowLost && st === SerialStatus.LOST);
    const live = known.find((k) => !mayReturn(k.status));
    if (live) {
      throw new BadRequestException(
        `Serial number "${live.serialNumber}" is already on file (${describeSerial(live)})`,
      );
    }
    if (known.length) {
      await db.serial.updateMany({
        where: { id: { in: known.map((k) => k.id) } },
        data: {
          status: SerialStatus.IN_STOCK,
          storeId: input.storeId,
          productId: input.productId,
          purchaseId: input.purchaseId ?? null,
          saleId: null,
          soldAt: null,
          note: input.note ?? null,
        },
      });
    }
    const fresh = new Set(known.map((k) => k.serialNumber));
    const toCreate = input.serials.filter((n) => !fresh.has(n));
    if (!toCreate.length) return;
    await db.serial.createMany({
      data: toCreate.map((serialNumber) => ({
        businessId: input.businessId,
        productId: input.productId,
        storeId: input.storeId,
        purchaseId: input.purchaseId ?? null,
        serialNumber,
        note: input.note ?? null,
      })),
    });
  }

  /**
   * Take named units off the shelf without a sale: DAMAGED (damage, expiry)
   * or LOST (theft, a count correction, missing at a stock take). Each must
   * be in stock at this store; the error names any that aren't.
   */
  async removeSerials(
    db: Db,
    input: {
      businessId: string;
      storeId: string;
      productId: string;
      serials: string[];
      status: 'DAMAGED' | 'LOST';
      note?: string | null;
    },
  ) {
    if (!input.serials.length) return;
    await this.assertInStockHere(db, input);
    await db.serial.updateMany({
      where: {
        businessId: input.businessId,
        productId: input.productId,
        storeId: input.storeId,
        serialNumber: { in: input.serials },
        status: SerialStatus.IN_STOCK,
      },
      data: { status: input.status, note: input.note ?? null },
    });
  }

  /**
   * Throw, naming the first serial that isn't in stock at this store for this
   * product, and saying where it is instead -- "sold on INV-000123", "at the
   * Lalitpur branch", "not on file". Called when a bulk update came up short
   * (or before one), so the cashier knows which scan to fix.
   */
  private async assertInStockHere(
    db: Db,
    input: { businessId: string; storeId: string; productId: string; serials: string[] },
  ) {
    const rows = await db.serial.findMany({
      where: { businessId: input.businessId, serialNumber: { in: input.serials } },
      select: {
        serialNumber: true,
        status: true,
        productId: true,
        storeId: true,
        store: { select: { name: true } },
        sale: { select: { receiptNo: true } },
        product: { select: { name: true } },
      },
    });
    const byNumber = new Map(rows.map((r) => [r.serialNumber, r]));
    for (const n of input.serials) {
      const r = byNumber.get(n);
      if (!r) throw new BadRequestException(`Serial number "${n}" is not on file`);
      if (r.productId !== input.productId) {
        throw new BadRequestException(`Serial number "${n}" belongs to ${r.product.name}`);
      }
      if (r.status !== SerialStatus.IN_STOCK || r.storeId !== input.storeId) {
        throw new BadRequestException(`Serial number "${n}" is not in stock here (${describeSerial(r)})`);
      }
    }
  }

  /** The in-stock serial numbers of one product at one store, oldest first. */
  async inStockSerials(businessId: string, storeId: string, productId: string) {
    const rows = await this.prisma.serial.findMany({
      where: { businessId, storeId, productId, status: SerialStatus.IN_STOCK },
      select: { serialNumber: true },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    return rows.map((r) => r.serialNumber);
  }

  /** One serial number, wherever it is: for scanning an IMEI at the till. */
  async lookupSerial(businessId: string, serialNumber: string) {
    const r = await this.prisma.serial.findUnique({
      where: { businessId_serialNumber: { businessId, serialNumber: serialNumber.trim() } },
      select: {
        serialNumber: true,
        status: true,
        productId: true,
        storeId: true,
        store: { select: { id: true, name: true } },
        sale: { select: { id: true, receiptNo: true } },
        product: { select: { id: true, name: true } },
      },
    });
    if (!r) throw new NotFoundException('No unit with that serial number');
    return { ...r, where: describeSerial(r) };
  }

  /**
   * Mark units sold. The IN_STOCK guard is what stops the same handset being
   * rung up twice: a second checkout matches zero rows and is rejected.
   */
  async sellSerials(
    db: Db,
    input: {
      businessId: string;
      storeId: string;
      productId: string;
      saleId: string;
      serials: string[];
    },
  ) {
    if (!input.serials.length) return;
    const res = await db.serial.updateMany({
      where: {
        businessId: input.businessId,
        productId: input.productId,
        storeId: input.storeId,
        serialNumber: { in: input.serials },
        status: SerialStatus.IN_STOCK,
      },
      data: {
        status: SerialStatus.SOLD,
        saleId: input.saleId,
        soldAt: new Date(),
      },
    });
    if (res.count !== input.serials.length) {
      await this.assertInStockHere(db, input);
      throw new BadRequestException('One or more serial numbers are not in stock at this store');
    }
  }

  /**
   * Customer return: put units back on the shelf. Named serials must belong
   * to this sale; when none are named the oldest sold units on the sale are
   * taken, so a return can be processed without re-scanning.
   *
   * A unit that came back damaged is marked DAMAGED instead: it is back in
   * the shop, but written off, so it can never be scanned into a sale again.
   */
  async returnSerialsToStock(
    db: Db,
    input: {
      businessId: string;
      storeId: string;
      productId: string;
      saleId: string;
      quantity: number;
      serials?: string[];
      damaged?: boolean;
    },
  ) {
    const ids = await this.pickSerials(db, {
      businessId: input.businessId,
      productId: input.productId,
      status: SerialStatus.SOLD,
      saleId: input.saleId,
      quantity: input.quantity,
      serials: input.serials,
    });
    if (!ids.length) return;
    await db.serial.updateMany({
      where: { id: { in: ids } },
      data: {
        status: input.damaged ? SerialStatus.DAMAGED : SerialStatus.IN_STOCK,
        storeId: input.storeId,
        soldAt: null,
      },
    });
  }

  /**
   * Customer return of a batch-tracked product: put the quantity back into a
   * batch, so expiry tracking counts it again. Without this every return
   * left the batches short of the shelf, and expiry alerts under-counted.
   *
   * ponytail: a sale consumes batches first-expiry-first without recording
   * which batch each unit came from, so the batch it goes back to is
   * inferred -- the earliest-expiring one the store already held when the
   * sale was made, which is the one FEFO would have taken it from. Erring
   * that way also warns about expiry sooner rather than later. Record the
   * batch on the sale line if exact traceability is ever needed.
   */
  async restoreBatchOnReturn(
    db: Db,
    input: { storeId: string; productId: string; quantity: number; soldAt: Date },
  ) {
    const batch = await db.batch.findFirst({
      where: {
        storeId: input.storeId,
        productId: input.productId,
        createdAt: { lte: input.soldAt },
      },
      // The same order a sale consumes them in (NULL expiries sort last).
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    // No batch to put it in: StockItem stays the source of truth, exactly as
    // when a sale finds its batches short.
    if (!batch) return;
    await db.batch.update({
      where: { id: batch.id },
      data: { quantity: { increment: String(round3(input.quantity)) } },
    });
  }

  /** Supplier return: take units off the shelf for good. */
  async returnSerialsToSupplier(
    db: Db,
    input: {
      businessId: string;
      productId: string;
      purchaseId: string;
      /** The purchase's store: the count goes down there, so the units must be there. */
      storeId: string;
      quantity: number;
      serials?: string[];
    },
  ) {
    const ids = await this.pickSerials(db, {
      businessId: input.businessId,
      productId: input.productId,
      status: SerialStatus.IN_STOCK,
      purchaseId: input.purchaseId,
      storeId: input.storeId,
      quantity: input.quantity,
      serials: input.serials,
    });
    if (!ids.length) return;
    await db.serial.updateMany({
      where: { id: { in: ids } },
      data: { status: SerialStatus.RETURNED_TO_SUPPLIER, storeId: null },
    });
  }

  /**
   * Follow a store transfer with the units themselves: the ones named (the
   * handsets actually put in the box), or the oldest on file when none are.
   */
  async moveSerials(
    db: Db,
    input: {
      businessId: string;
      productId: string;
      fromStoreId: string;
      toStoreId: string;
      quantity: number;
      serials?: string[];
    },
  ) {
    const named = (input.serials ?? []).map((v) => v.trim()).filter(Boolean);
    if (named.length) {
      if (named.length !== input.quantity || new Set(named).size !== named.length) {
        throw new BadRequestException(
          `Transferring ${input.quantity} unit(s) needs ${input.quantity} different serial number(s), got ${named.length}`,
        );
      }
      await this.assertInStockHere(db, {
        businessId: input.businessId,
        storeId: input.fromStoreId,
        productId: input.productId,
        serials: named,
      });
      await db.serial.updateMany({
        where: {
          businessId: input.businessId,
          productId: input.productId,
          storeId: input.fromStoreId,
          status: SerialStatus.IN_STOCK,
          serialNumber: { in: named },
        },
        data: { storeId: input.toStoreId },
      });
      return;
    }
    const units = await db.serial.findMany({
      where: {
        businessId: input.businessId,
        productId: input.productId,
        storeId: input.fromStoreId,
        status: SerialStatus.IN_STOCK,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: input.quantity,
    });
    if (units.length < input.quantity) {
      throw new BadRequestException(
        'Not enough serialised units in the source store for this transfer',
      );
    }
    await db.serial.updateMany({
      where: { id: { in: units.map((u) => u.id) } },
      data: { storeId: input.toStoreId },
    });
  }

  /**
   * Resolve which units a return applies to: the ones the caller named, or
   * the oldest matching units when they named none.
   */
  private async pickSerials(
    db: Db,
    input: {
      businessId: string;
      productId: string;
      status: SerialStatus;
      saleId?: string;
      purchaseId?: string;
      storeId?: string;
      quantity: number;
      serials?: string[];
    },
  ) {
    const scope = {
      businessId: input.businessId,
      productId: input.productId,
      status: input.status,
      ...(input.saleId ? { saleId: input.saleId } : {}),
      ...(input.purchaseId ? { purchaseId: input.purchaseId } : {}),
      ...(input.storeId ? { storeId: input.storeId } : {}),
    };
    const named = (input.serials ?? []).map((v) => v.trim()).filter(Boolean);
    if (named.length) {
      if (named.length !== input.quantity) {
        throw new BadRequestException(
          `Returning ${input.quantity} unit(s) needs ${input.quantity} serial number(s), got ${named.length}`,
        );
      }
      const found = await db.serial.findMany({
        where: { ...scope, serialNumber: { in: named } },
        select: { id: true },
      });
      if (found.length !== named.length) {
        throw new BadRequestException(
          'One or more serial numbers do not belong to this transaction',
        );
      }
      return found.map((f) => f.id);
    }
    const oldest = await db.serial.findMany({
      where: scope,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: input.quantity,
    });
    if (oldest.length < input.quantity) {
      throw new BadRequestException(
        'Not enough serialised units to return; supply the serial numbers explicitly',
      );
    }
    return oldest.map((o) => o.id);
  }

  /** Where is unit X? Search by serial, or list what a product/store holds. */
  async listSerials(businessId: string, q: QuerySerialsDto) {
    const where: Prisma.SerialWhereInput = {
      businessId,
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? { serialNumber: { contains: q.search, mode: 'insensitive' } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.serial.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          product: { select: { id: true, name: true, sku: true } },
          store: { select: { id: true, name: true } },
          sale: {
            select: {
              id: true,
              receiptNo: true,
              createdAt: true,
              customer: { select: { id: true, name: true, phone: true } },
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.serial.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  /**
   * Stock that has expired or expires within `days`, soonest first: batches
   * that still hold stock, and stock of products whose own expiry date (set
   * on the product, no batches) falls in the window. Product-level rows get a
   * stable synthetic id, `product:<storeId>:<productId>`, so alerts can
   * dedupe on it like a batch id.
   */
  async expiringBatches(businessId: string, q: ExpiringDto) {
    const now = new Date();
    const cutoff = soonCutoff(now, q.days);
    const [batches, productStock] = await Promise.all([
      this.prisma.batch.findMany({
        where: {
          businessId,
          ...(q.storeId ? { storeId: q.storeId } : {}),
          quantity: { gt: 0 },
          expiryDate: { not: null, lte: cutoff },
        },
        include: {
          product: { select: { id: true, name: true, sku: true } },
          store: { select: { id: true, name: true } },
        },
        orderBy: { expiryDate: 'asc' },
      }),
      this.prisma.stockItem.findMany({
        where: {
          businessId,
          ...(q.storeId ? { storeId: q.storeId } : {}),
          quantity: { gt: 0 },
          product: { isActive: true, expiryDate: { not: null, lte: cutoff } },
        },
        select: {
          storeId: true,
          productId: true,
          quantity: true,
          product: { select: { id: true, name: true, sku: true, expiryDate: true } },
          store: { select: { id: true, name: true } },
        },
      }),
    ]);
    const rows = [
      ...batches.map((b) => ({
        ...b,
        source: 'batch' as const,
        expired: isExpired(b.expiryDate, now),
      })),
      ...productStock.map(({ product: { expiryDate, ...product }, ...s }) => ({
        id: `product:${s.storeId}:${s.productId}`,
        source: 'product' as const,
        storeId: s.storeId,
        productId: s.productId,
        batchNumber: null,
        expiryDate,
        quantity: s.quantity,
        product,
        store: s.store,
        expired: isExpired(expiryDate, now),
      })),
    ];
    return rows.sort((a, b) => a.expiryDate!.getTime() - b.expiryDate!.getTime());
  }

  /**
   * Take expired stock off the shelf in one step: an EXPIRED adjustment for
   * what's left, and -- for a batch -- the batch emptied too. A plain
   * adjustment leaves the batch holding its quantity, so it stayed on the
   * Expiring list and kept being counted as expired stock.
   *
   * Only stock that really has expired: a date still ahead is refused, so
   * this can't be used to write off good stock by mistake.
   */
  async writeOffExpired(businessId: string, userId: string, dto: WriteOffExpiredDto) {
    await this.assertStoreAndProduct(businessId, dto.storeId, dto.productId);
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.stockItem.findUnique({
        where: { storeId_productId: { storeId: dto.storeId, productId: dto.productId } },
        select: { quantity: true },
      });
      const onHand = Number(item?.quantity ?? 0);
      let qty: number;
      let note: string;
      if (dto.batchId) {
        const batch = await tx.batch.findFirst({
          where: { id: dto.batchId, businessId, storeId: dto.storeId, productId: dto.productId },
        });
        if (!batch) throw new NotFoundException('Batch not found');
        if (!isExpired(batch.expiryDate)) throw new BadRequestException('This batch has not expired yet');
        // Never more than the shelf holds, even if the batch books drifted.
        qty = round3(Math.min(Number(batch.quantity), onHand));
        await tx.batch.update({ where: { id: batch.id }, data: { quantity: 0 } });
        note = `Expired batch${batch.batchNumber ? ` ${batch.batchNumber}` : ''} written off`;
      } else {
        const product = await tx.product.findUnique({
          where: { id: dto.productId },
          select: { expiryDate: true, trackSerials: true },
        });
        if (!isExpired(product?.expiryDate)) throw new BadRequestException('This product has not expired yet');
        qty = round3(onHand);
        note = 'Expired stock written off';
        // Every unit here is going: take them off the serial list as well.
        if (product?.trackSerials) {
          await tx.serial.updateMany({
            where: { businessId, storeId: dto.storeId, productId: dto.productId, status: SerialStatus.IN_STOCK },
            data: { status: SerialStatus.DAMAGED, note },
          });
        }
      }
      if (qty > 0) {
        await this.applyMovement(tx, {
          businessId,
          storeId: dto.storeId,
          productId: dto.productId,
          type: StockMovementType.ADJUSTMENT,
          quantity: -qty,
          reason: AdjustmentReason.EXPIRED,
          note,
          userId,
        });
      }
      return { writtenOff: qty };
    }, TX_OPTS);
  }

  async movements(businessId: string, q: QueryMovementsDto) {
    const where: Prisma.StockMovementWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          product: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
          // So an "all stores" view can say which branch each movement was at.
          store: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  /**
   * Move stock between two stores. One transaction, two movements per line
   * (out of the source, into the destination) sharing a `reference` so the
   * pair is traceable from either side's history. Batch-tracked products
   * carry their batches across too, oldest expiry first, so a transfer never
   * silently drops expiry data.
   */
  async transfer(businessId: string, userId: string, dto: TransferStockDto) {
    if (dto.fromStoreId === dto.toStoreId) {
      throw new BadRequestException('Source and destination stores must differ');
    }
    const productIds = dto.items.map((i) => i.productId);
    const [from, to, products] = await Promise.all([
      this.prisma.store.findFirst({ where: { id: dto.fromStoreId, businessId } }),
      this.prisma.store.findFirst({ where: { id: dto.toStoreId, businessId } }),
      this.prisma.product.findMany({
        where: { id: { in: productIds }, businessId },
        select: { id: true, name: true, trackBatches: true, trackSerials: true },
      }),
    ]);
    if (!from) throw new NotFoundException('Source store not found');
    if (!to) throw new NotFoundException('Destination store not found');
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }
    const tracked = new Set(
      products.filter((p) => p.trackBatches).map((p) => p.id),
    );
    const serialised = new Set(
      products.filter((p) => p.trackSerials).map((p) => p.id),
    );
    const reference = `TRF-${randomUUID()}`;

    await this.prisma.$transaction(async (tx) => {
      // The source leg is guarded (it cannot drive stock negative); the
      // destination leg just adds. Both go in one batch, so a short source
      // rolls the whole transfer back.
      await this.applyMovementsBatch(
        tx,
        dto.items.flatMap((i) => [
          {
            businessId,
            storeId: dto.fromStoreId,
            productId: i.productId,
            type: StockMovementType.TRANSFER,
            quantity: -i.quantity,
            userId,
            note: dto.note ?? `Transfer to ${to.name}`,
            reference,
          },
          {
            businessId,
            storeId: dto.toStoreId,
            productId: i.productId,
            type: StockMovementType.TRANSFER,
            quantity: i.quantity,
            userId,
            note: dto.note ?? `Transfer from ${from.name}`,
            reference,
          },
        ]),
      );
      // Serialised goods: the units themselves follow the quantity, so a
      // later sale at the destination store can still find them in stock.
      for (const i of dto.items.filter((i) => serialised.has(i.productId))) {
        await this.moveSerials(tx, {
          businessId,
          productId: i.productId,
          fromStoreId: dto.fromStoreId,
          toStoreId: dto.toStoreId,
          quantity: i.quantity,
          serials: i.serials,
        });
      }
      const batchLines = dto.items.filter((i) => tracked.has(i.productId));
      if (batchLines.length) {
        await this.moveBatchesFEFO(
          tx,
          businessId,
          dto.fromStoreId,
          dto.toStoreId,
          batchLines,
        );
      }
    }, TX_OPTS);

    return {
      reference,
      fromStore: { id: from.id, name: from.name },
      toStore: { id: to.id, name: to.name },
      items: dto.items,
      transferredAt: new Date(),
    };
  }

  /**
   * Post a physical count for a whole store: one ADJUSTMENT movement per
   * product whose count differs from the system balance, all in a single
   * transaction (and a single audit-log entry). `preview: true` returns the
   * same variance list without writing anything, so the count can be checked
   * before it is posted.
   */
  async stockTake(businessId: string, userId: string, dto: StockTakeDto) {
    const productIds = dto.counts.map((c) => c.productId);
    const [store, products] = await Promise.all([
      this.prisma.store.findFirst({ where: { id: dto.storeId, businessId } }),
      this.prisma.product.findMany({
        where: { id: { in: productIds }, businessId },
        select: { id: true, name: true, sku: true, unit: true, trackSerials: true },
      }),
    ]);
    if (!store) throw new NotFoundException('Store not found');
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Serialised products are counted by serial: the list of units found is
    // the count. Validated up front so a bad list never half-posts.
    const serialsCounted = new Map<string, string[]>();
    for (const c of dto.counts) {
      const p = productMap.get(c.productId)!;
      if (c.serials === undefined) continue;
      const list = InventoryService.checkSerials(p, c.serials.length, c.serials);
      if (list.length !== c.counted) {
        throw new BadRequestException(
          `"${p.name}": counted ${c.counted}, but ${list.length} serial number(s) listed`,
        );
      }
      serialsCounted.set(c.productId, list);
    }

    const variances = async (db: Db) => {
      const current = await db.stockItem.findMany({
        where: { storeId: dto.storeId, productId: { in: productIds } },
        select: { productId: true, quantity: true },
      });
      const have = new Map(current.map((s) => [s.productId, Number(s.quantity)]));
      return dto.counts.map((c) => {
        const system = have.get(c.productId) ?? 0;
        const p = productMap.get(c.productId)!;
        const variance = round3(c.counted - system);
        return {
          productId: c.productId,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          system,
          counted: c.counted,
          variance,
          // A serialised product whose count changed has to say which units:
          // the review screen asks for them before it can be posted.
          needsSerials: p.trackSerials && variance !== 0 && !serialsCounted.has(c.productId),
        };
      });
    };

    if (dto.preview) {
      const lines = await variances(this.prisma);
      return {
        storeId: dto.storeId,
        preview: true,
        counted: lines.length,
        adjusted: lines.filter((l) => l.variance !== 0).length,
        lines,
      };
    }

    const reference = `COUNT-${randomUUID()}`;
    return this.prisma.$transaction(async (tx) => {
      // Balances are read inside the transaction so the posted delta is
      // against a value no older than this transaction. A sale committing
      // mid-count keeps its own deduction (an adjustment is a delta, not an
      // overwrite) -- the count is simply as of the moment it was taken.
      const lines = await variances(tx);
      const unnamed = lines.find((l) => l.needsSerials);
      if (unnamed) {
        throw new BadRequestException(
          `"${unnamed.name}" is tracked by serial number — tick the units you counted before posting`,
        );
      }
      const changed = lines.filter((l) => l.variance !== 0);
      if (changed.length) {
        await this.applyMovementsBatch(
          tx,
          changed.map((l) => ({
            businessId,
            storeId: dto.storeId,
            productId: l.productId,
            type: StockMovementType.ADJUSTMENT,
            quantity: l.variance,
            reason: AdjustmentReason.COUNT_CORRECTION,
            userId,
            note: dto.note ?? 'Stock take',
            reference,
          })),
          { allowNegative: true }, // the physical count wins, whatever it says
        );
        // Batch-tracked products: a shortfall comes out of the batches
        // first-expiry-first, stock found goes into an undated batch -- the
        // count can't say which batch it belongs to.
        await this.syncBatches(
          tx,
          businessId,
          dto.storeId,
          changed.map((l) => ({ productId: l.productId, quantity: l.variance })),
        );
      }
      // Bring the serial list to exactly the units counted: missing ones are
      // LOST, found ones (not on file, or lost and since found) go in stock.
      for (const [productId, counted] of serialsCounted) {
        const onFile = await tx.serial.findMany({
          where: { businessId, storeId: dto.storeId, productId, status: SerialStatus.IN_STOCK },
          select: { serialNumber: true },
        });
        const have = new Set(onFile.map((r) => r.serialNumber));
        const seen = new Set(counted);
        const unit = { businessId, storeId: dto.storeId, productId };
        await this.removeSerials(tx, {
          ...unit,
          serials: [...have].filter((n) => !seen.has(n)),
          status: 'LOST',
          note: dto.note ?? 'Missing at stock take',
        });
        await this.receiveSerials(tx, {
          ...unit,
          serials: counted.filter((n) => !have.has(n)),
          note: dto.note ?? 'Found at stock take',
          allowLost: true,
        });
      }
      return {
        storeId: dto.storeId,
        reference,
        counted: lines.length,
        adjusted: changed.length,
        lines,
      };
    }, TX_OPTS);
  }

  /**
   * Blank count sheet for a store: every active product with its current
   * system quantity, for CSV download (the client turns the rows into a
   * file, same as the product export).
   */
  async countSheet(businessId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId },
    });
    if (!store) throw new NotFoundException('Store not found');
    const products = await this.prisma.product.findMany({
      where: { businessId, isActive: true },
      select: {
        id: true,
        name: true,
        sku: true,
        unit: true,
        trackSerials: true,
        stockItems: { where: { storeId }, select: { quantity: true } },
      },
      orderBy: { name: 'asc' },
    });
    // Serialised products are counted by ticking units, so each carries the
    // serials on file here. One query for the whole store.
    const units = await this.prisma.serial.findMany({
      where: {
        businessId,
        storeId,
        status: SerialStatus.IN_STOCK,
        productId: { in: products.filter((p) => p.trackSerials).map((p) => p.id) },
      },
      select: { productId: true, serialNumber: true },
      orderBy: { createdAt: 'asc' },
    });
    const unitsByProduct = new Map<string, string[]>();
    for (const u of units) {
      const list = unitsByProduct.get(u.productId) ?? [];
      list.push(u.serialNumber);
      unitsByProduct.set(u.productId, list);
    }
    return products.map((p) => ({
      productId: p.id,
      sku: p.sku ?? '',
      name: p.name,
      unit: p.unit,
      system: Number(p.stockItems[0]?.quantity ?? 0),
      counted: '', // filled in by hand, then posted to /inventory/stock-take
      trackSerials: p.trackSerials,
      ...(p.trackSerials ? { serials: unitsByProduct.get(p.id) ?? [] } : {}),
    }));
  }

  /**
   * Carry batch quantities from one store to another, oldest expiry first,
   * merging into a batch with the same natural key at the destination
   * (mirrors purchases' createBatchIfNeeded so the two cannot fork).
   */
  private async moveBatchesFEFO(
    tx: Prisma.TransactionClient,
    businessId: string,
    fromStoreId: string,
    toStoreId: string,
    items: { productId: string; quantity: number }[],
  ) {
    const batches = await tx.batch.findMany({
      where: {
        storeId: fromStoreId,
        productId: { in: items.map((i) => i.productId) },
        quantity: { gt: 0 },
      },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });
    const byProduct = new Map<string, typeof batches>();
    for (const b of batches) {
      const arr = byProduct.get(b.productId);
      if (arr) arr.push(b);
      else byProduct.set(b.productId, [b]);
    }

    for (const item of items) {
      let remaining = item.quantity;
      for (const b of byProduct.get(item.productId) ?? []) {
        if (remaining <= 0) break;
        const available = Number(b.quantity);
        if (available <= 0) continue;
        const take = round3(Math.min(available, remaining));
        await tx.batch.update({
          where: { id: b.id },
          data: { quantity: { decrement: take } },
        });
        const existing = await tx.batch.findFirst({
          where: {
            storeId: toStoreId,
            productId: item.productId,
            batchNumber: b.batchNumber,
            expiryDate: b.expiryDate,
          },
        });
        if (existing) {
          await tx.batch.update({
            where: { id: existing.id },
            data: { quantity: { increment: take } },
          });
        } else {
          await tx.batch.create({
            data: {
              businessId,
              storeId: toStoreId,
              productId: item.productId,
              batchNumber: b.batchNumber,
              expiryDate: b.expiryDate,
              quantity: take,
              costPrice: b.costPrice,
            },
          });
        }
        b.quantity = new Prisma.Decimal(round3(available - take));
        remaining = round3(remaining - take);
      }
      // Batches short of the transferred amount: StockItem stays the source
      // of truth, exactly as consumeBatchesFEFO does on a sale.
    }
  }

  private async assertStoreAndProduct(
    businessId: string,
    storeId: string,
    productId: string,
  ) {
    const [store, product] = await Promise.all([
      this.prisma.store.findFirst({ where: { id: storeId, businessId } }),
      this.prisma.product.findFirst({ where: { id: productId, businessId } }),
    ]);
    if (!store) throw new NotFoundException('Store not found');
    if (!product) throw new NotFoundException('Product not found');
  }
}
