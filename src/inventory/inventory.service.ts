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
import { AdjustStockDto, SetReorderLevelDto } from './dto/adjust-stock.dto';
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

  /** Manual stock adjustment (damage, count correction, etc.). */
  async adjust(businessId: string, userId: string, dto: AdjustStockDto) {
    await this.assertStoreAndProduct(businessId, dto.storeId, dto.productId);
    return this.prisma.$transaction(
      (tx) =>
        this.applyMovement(tx, {
          businessId,
          storeId: dto.storeId,
          productId: dto.productId,
          type: StockMovementType.ADJUSTMENT,
          quantity: dto.delta,
          reason: dto.reason,
          note: dto.note,
          userId,
        }),
      TX_OPTS,
    );
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
            select: { id: true, name: true, sku: true, unit: true, reorderLevel: true },
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
  async lowStock(businessId: string, storeId?: string) {
    const items = await this.prisma.stockItem.findMany({
      where: { businessId, ...(storeId ? { storeId } : {}) },
      include: {
        product: {
          select: { id: true, name: true, sku: true, unit: true, costPrice: true, reorderLevel: true },
        },
        store: { select: { id: true, name: true } },
      },
    });
    return items
      .map((it) => ({
        ...it,
        effectiveReorderLevel: it.reorderLevel || it.product.reorderLevel,
      }))
      .filter(
        (it) =>
          it.effectiveReorderLevel > 0 &&
          Number(it.quantity) <= it.effectiveReorderLevel,
      );
  }

  // ---- Serial / IMEI tracking ----
  //
  // Serial rows say *which* units are on the shelf; StockItem still owns the
  // count. The two are kept in step on every path that knows about specific
  // units (receive, sell, both kinds of return, transfer).
  //
  // ponytail: a manual adjustment or a stock take moves the count without
  // naming units, so those leave the serial list untouched and it can drift
  // from the StockItem balance. Reconcile against this list if that turns
  // into a real problem in the shop.

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

  /** Book received units into stock. Rejects a serial already on file. */
  async receiveSerials(
    db: Db,
    input: {
      businessId: string;
      storeId: string;
      productId: string;
      purchaseId: string;
      serials: string[];
    },
  ) {
    if (!input.serials.length) return;
    const known = await db.serial.findMany({
      where: {
        businessId: input.businessId,
        serialNumber: { in: input.serials },
      },
      select: { id: true, serialNumber: true, status: true },
    });
    // A unit sent back to the supplier can legitimately come back (a repaired
    // swap, a re-delivery); anything still in stock or sold is a mis-scan.
    const live = known.find((k) => k.status !== SerialStatus.RETURNED_TO_SUPPLIER);
    if (live) {
      throw new BadRequestException(
        `Serial number "${live.serialNumber}" is already on file`,
      );
    }
    if (known.length) {
      await db.serial.updateMany({
        where: { id: { in: known.map((k) => k.id) } },
        data: {
          status: SerialStatus.IN_STOCK,
          storeId: input.storeId,
          productId: input.productId,
          purchaseId: input.purchaseId,
          saleId: null,
          soldAt: null,
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
        purchaseId: input.purchaseId,
        serialNumber,
      })),
    });
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
      throw new BadRequestException(
        'One or more serial numbers are not in stock at this store',
      );
    }
  }

  /**
   * Customer return: put units back on the shelf. Named serials must belong
   * to this sale; when none are named the oldest sold units on the sale are
   * taken, so a return can be processed without re-scanning.
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
        status: SerialStatus.IN_STOCK,
        storeId: input.storeId,
        soldAt: null,
      },
    });
  }

  /** Supplier return: take units off the shelf for good. */
  async returnSerialsToSupplier(
    db: Db,
    input: {
      businessId: string;
      productId: string;
      purchaseId: string;
      quantity: number;
      serials?: string[];
    },
  ) {
    const ids = await this.pickSerials(db, {
      businessId: input.businessId,
      productId: input.productId,
      status: SerialStatus.IN_STOCK,
      purchaseId: input.purchaseId,
      quantity: input.quantity,
      serials: input.serials,
    });
    if (!ids.length) return;
    await db.serial.updateMany({
      where: { id: { in: ids } },
      data: { status: SerialStatus.RETURNED_TO_SUPPLIER, storeId: null },
    });
  }

  /** Follow a store transfer with the units themselves. */
  async moveSerials(
    db: Db,
    input: {
      businessId: string;
      productId: string;
      fromStoreId: string;
      toStoreId: string;
      quantity: number;
    },
  ) {
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

  async expiringBatches(businessId: string, q: ExpiringDto) {
    // Caller passes the cutoff via days; compared against now at query time.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + q.days);
    return this.prisma.batch.findMany({
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
    });
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
        select: { id: true, name: true, sku: true, unit: true },
      }),
    ]);
    if (!store) throw new NotFoundException('Store not found');
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    const variances = async (db: Db) => {
      const current = await db.stockItem.findMany({
        where: { storeId: dto.storeId, productId: { in: productIds } },
        select: { productId: true, quantity: true },
      });
      const have = new Map(current.map((s) => [s.productId, Number(s.quantity)]));
      return dto.counts.map((c) => {
        const system = have.get(c.productId) ?? 0;
        const p = productMap.get(c.productId)!;
        return {
          productId: c.productId,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          system,
          counted: c.counted,
          variance: round3(c.counted - system),
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
        stockItems: { where: { storeId }, select: { quantity: true } },
      },
      orderBy: { name: 'asc' },
    });
    return products.map((p) => ({
      productId: p.id,
      sku: p.sku ?? '',
      name: p.name,
      unit: p.unit,
      system: Number(p.stockItems[0]?.quantity ?? 0),
      counted: '', // filled in by hand, then posted to /inventory/stock-take
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
