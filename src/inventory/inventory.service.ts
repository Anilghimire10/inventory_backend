import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdjustmentReason,
  Prisma,
  PrismaClient,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdjustStockDto, SetReorderLevelDto } from './dto/adjust-stock.dto';
import {
  ExpiringDto,
  QueryMovementsDto,
  QueryStockDto,
} from './dto/query-inventory.dto';
import { paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';

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
    const rows = await db.$queryRaw<{ quantity: number }[]>`
      UPDATE "StockItem"
      SET quantity = quantity + ${quantity}
      WHERE "storeId" = ${storeId} AND "productId" = ${productId}
        AND (${allowNegative} OR quantity + ${quantity} >= 0)
      RETURNING quantity
    `;
    if (rows.length === 0) {
      const existing = await db.stockItem.findUnique({
        where: { storeId_productId: { storeId, productId } },
      });
      throw new BadRequestException(
        `Insufficient stock (have ${existing?.quantity ?? 0}, need ${-quantity})`,
      );
    }

    await db.stockMovement.create({
      data: {
        businessId,
        storeId,
        productId,
        userId: input.userId ?? null,
        type: input.type,
        quantity,
        reason: input.reason ?? null,
        note: input.note ?? null,
        reference: input.reference ?? null,
      },
    });

    return rows[0].quantity;
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
      if (g) g.delta += inp.quantity;
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
    const deltas = values.map((g) => g.delta);
    const updated = await db.$queryRaw<
      { storeId: string; productId: string; quantity: number }[]
    >`
      UPDATE "StockItem" AS si
      SET quantity = si.quantity + v.delta
      FROM (
        SELECT * FROM UNNEST(${storeIds}::text[], ${productIds}::text[], ${deltas}::int[])
      ) AS v(store_id, product_id, delta)
      WHERE si."storeId" = v.store_id AND si."productId" = v.product_id
        AND (${allowNegative} OR si.quantity + v.delta >= 0)
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
        quantity: inp.quantity,
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
    const [data, total] = await this.prisma.$transaction([
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
        product: { select: { id: true, name: true, sku: true, reorderLevel: true } },
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
          it.quantity <= it.effectiveReorderLevel,
      );
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
    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          product: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
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
