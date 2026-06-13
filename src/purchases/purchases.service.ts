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
import { PaginationDto, paginate } from '../common/dto/pagination.dto';

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

    const subtotal = dto.items.reduce(
      (sum, i) => sum + i.quantity * i.costPrice,
      0,
    );
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
          total: subtotal,
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
    });
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
    });
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
    return paginate(data, total, q.page, q.limit);
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
    return purchase;
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
