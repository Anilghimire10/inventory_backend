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

    const existing = await db.stockItem.findUnique({
      where: { storeId_productId: { storeId, productId } },
    });
    const current = existing?.quantity ?? 0;
    const next = current + quantity;

    if (next < 0 && !opts.allowNegative) {
      throw new BadRequestException(
        `Insufficient stock (have ${current}, need ${-quantity})`,
      );
    }

    await db.stockItem.upsert({
      where: { storeId_productId: { storeId, productId } },
      create: { businessId, storeId, productId, quantity: next },
      update: { quantity: next },
    });

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

    return next;
  }

  /** Manual stock adjustment (damage, count correction, etc.). */
  async adjust(businessId: string, userId: string, dto: AdjustStockDto) {
    await this.assertStoreAndProduct(businessId, dto.storeId, dto.productId);
    return this.prisma.$transaction((tx) =>
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
