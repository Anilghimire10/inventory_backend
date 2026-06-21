import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  PurchaseStatus,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  async create(businessId: string, dto: CreatePurchaseDto) {
    await this.assertStore(businessId, dto.storeId);
    if (dto.supplierId) await this.assertSupplier(businessId, dto.supplierId);

    // Validate all products belong to this business
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, businessId },
    });
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    const subtotal = round2(
      dto.items.reduce((sum, i) => sum + i.quantity * i.costPrice, 0),
    );
    const total = subtotal;
    // Paid in full by default; pass a smaller amountPaid to buy on credit.
    const amountPaid = Math.min(Math.max(dto.amountPaid ?? total, 0), total);
    const receiveNow = dto.receiveNow !== false;

    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.create({
        data: {
          businessId,
          storeId: dto.storeId,
          supplierId: dto.supplierId,
          reference: dto.reference,
          note: dto.note,
          status: receiveNow ? PurchaseStatus.RECEIVED : PurchaseStatus.DRAFT,
          subtotal,
          tax: 0,
          total,
          amountPaid,
          receivedAt: receiveNow ? new Date() : null,
          items: {
            create: dto.items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              costPrice: i.costPrice,
              batchNumber: i.batchNumber,
              expiryDate: i.expiryDate ? new Date(i.expiryDate) : null,
            })),
          },
        },
        include: { items: true },
      });

      if (receiveNow) {
        await this.receiveItems(tx, businessId, dto.storeId, purchase.id, dto, productMap);
      }
      return purchase;
    }, TX_OPTS);
  }

  /**
   * Edit an existing purchase. For a RECEIVED purchase this reverses the old
   * stock, swaps the line items, then re-applies the new stock — all in one
   * transaction. Editing is blocked if some of the original stock has already
   * been sold/moved (the reversal would drive stock negative).
   */
  async update(businessId: string, id: string, dto: UpdatePurchaseDto) {
    const existing = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundException('Purchase not found');
    if (existing.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('A cancelled purchase cannot be edited');
    }

    const items = dto.items ?? existing.items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      costPrice: Number(i.costPrice),
      batchNumber: i.batchNumber ?? undefined,
      expiryDate: i.expiryDate ? i.expiryDate.toISOString() : undefined,
    }));
    if (!items.length) {
      throw new BadRequestException('A purchase needs at least one item');
    }

    const newStoreId = dto.storeId ?? existing.storeId;
    await this.assertStore(businessId, newStoreId);
    if (dto.supplierId) await this.assertSupplier(businessId, dto.supplierId);

    const productIds = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, businessId },
    });
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }

    const subtotal = round2(
      items.reduce((sum, i) => sum + i.quantity * i.costPrice, 0),
    );
    const total = subtotal;
    const amountPaid = Math.min(
      Math.max(dto.amountPaid ?? Number(existing.amountPaid), 0),
      total,
    );
    const wasReceived = existing.status === PurchaseStatus.RECEIVED;

    return this.prisma.$transaction(async (tx) => {
      // 1. Back out the stock this purchase had already added.
      if (wasReceived) {
        for (const item of existing.items) {
          try {
            await this.inventory.applyMovement(tx, {
              businessId,
              storeId: existing.storeId,
              productId: item.productId,
              type: StockMovementType.PURCHASE,
              quantity: -item.quantity,
              reference: existing.id,
              note: 'Purchase edited — original stock reversed',
            });
          } catch {
            throw new BadRequestException(
              'Cannot edit: some of this purchase’s stock has already been sold or moved',
            );
          }
        }
      }

      // 2. Replace the line items and recompute totals.
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
      await tx.purchase.update({
        where: { id },
        data: {
          storeId: newStoreId,
          supplierId: dto.supplierId ?? null,
          reference: dto.reference ?? null,
          note: dto.note ?? null,
          subtotal,
          tax: 0,
          total,
          amountPaid,
          items: {
            create: items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              costPrice: i.costPrice,
              batchNumber: i.batchNumber,
              expiryDate: i.expiryDate ? new Date(i.expiryDate) : null,
            })),
          },
        },
      });

      // 3. Re-apply stock for the new lines (only if already received).
      if (wasReceived) {
        for (const item of items) {
          await this.inventory.applyMovement(tx, {
            businessId,
            storeId: newStoreId,
            productId: item.productId,
            type: StockMovementType.PURCHASE,
            quantity: item.quantity,
            reference: id,
          });
          await this.createBatchIfNeeded(tx, businessId, newStoreId, {
            productId: item.productId,
            quantity: item.quantity,
            costPrice: new Prisma.Decimal(item.costPrice),
            batchNumber: item.batchNumber ?? null,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
          });
          await tx.product.update({
            where: { id: item.productId },
            data: { costPrice: item.costPrice },
          });
        }
      }

      const updated = await tx.purchase.findFirstOrThrow({
        where: { id },
        include: { items: true },
      });
      return {
        ...updated,
        outstanding: round2(Number(updated.total) - Number(updated.amountPaid)),
      };
    }, TX_OPTS);
  }

  /** Receive a draft purchase: add stock, create batches, update cost. */
  async receive(businessId: string, id: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: { items: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    if (purchase.status === PurchaseStatus.RECEIVED) {
      throw new BadRequestException('Purchase already received');
    }
    if (purchase.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('Purchase was cancelled');
    }

    return this.prisma.$transaction(async (tx) => {
      for (const item of purchase.items) {
        await this.inventory.applyMovement(tx, {
          businessId,
          storeId: purchase.storeId,
          productId: item.productId,
          type: StockMovementType.PURCHASE,
          quantity: item.quantity,
          reference: purchase.id,
        });
        await this.createBatchIfNeeded(tx, businessId, purchase.storeId, item);
        await tx.product.update({
          where: { id: item.productId },
          data: { costPrice: item.costPrice },
        });
      }
      return tx.purchase.update({
        where: { id },
        data: { status: PurchaseStatus.RECEIVED, receivedAt: new Date() },
        include: { items: true },
      });
    }, TX_OPTS);
  }

  /** Record a payment to the supplier against a purchase (clamped to the total). */
  async recordPayment(businessId: string, id: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    const outstanding = round2(Number(purchase.total) - Number(purchase.amountPaid));
    if (amount > outstanding + 0.001) {
      throw new BadRequestException(
        `Payment exceeds the outstanding ${outstanding}`,
      );
    }
    const updated = await this.prisma.purchase.update({
      where: { id },
      data: { amountPaid: { increment: amount } },
    });
    return {
      ...updated,
      outstanding: round2(Number(updated.total) - Number(updated.amountPaid)),
    };
  }

  async findAll(businessId: string, q: PaginationDto) {
    const where: Prisma.PurchaseWhereInput = { businessId };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchase.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          supplier: { select: { id: true, name: true } },
          store: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.purchase.count({ where }),
    ]);
    const mapped = data.map((p) => ({
      ...p,
      outstanding: round2(Number(p.total) - Number(p.amountPaid)),
    }));
    return paginate(mapped, total, q.page, q.limit);
  }

  async findOne(businessId: string, id: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: {
        supplier: true,
        store: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true } } } },
      },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    return {
      ...purchase,
      outstanding: round2(Number(purchase.total) - Number(purchase.amountPaid)),
    };
  }

  // ---- helpers ----

  private async receiveItems(
    tx: Prisma.TransactionClient,
    businessId: string,
    storeId: string,
    purchaseId: string,
    dto: CreatePurchaseDto,
    productMap: Map<string, { id: string }>,
  ) {
    for (const item of dto.items) {
      await this.inventory.applyMovement(tx, {
        businessId,
        storeId,
        productId: item.productId,
        type: StockMovementType.PURCHASE,
        quantity: item.quantity,
        reference: purchaseId,
      });
      await this.createBatchIfNeeded(tx, businessId, storeId, {
        productId: item.productId,
        quantity: item.quantity,
        costPrice: new Prisma.Decimal(item.costPrice),
        batchNumber: item.batchNumber ?? null,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
      });
      await tx.product.update({
        where: { id: item.productId },
        data: { costPrice: item.costPrice },
      });
    }
  }

  private async createBatchIfNeeded(
    tx: Prisma.TransactionClient,
    businessId: string,
    storeId: string,
    item: {
      productId: string;
      quantity: number;
      costPrice: Prisma.Decimal;
      batchNumber: string | null;
      expiryDate: Date | null;
    },
  ) {
    if (!item.batchNumber && !item.expiryDate) return;
    await tx.batch.create({
      data: {
        businessId,
        storeId,
        productId: item.productId,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
        quantity: item.quantity,
        costPrice: item.costPrice,
      },
    });
  }

  private async assertStore(businessId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId },
    });
    if (!store) throw new BadRequestException('Invalid store');
  }

  private async assertSupplier(businessId: string, supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, businessId },
    });
    if (!supplier) throw new BadRequestException('Invalid supplier');
  }
}
