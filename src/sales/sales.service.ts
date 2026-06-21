import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentMethod,
  Prisma,
  SaleStatus,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { MailService } from '../mail/mail.service';
import { AuthUser } from '../common/types/auth-user';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ReturnSaleDto } from './dto/return-sale.dto';
import { QuerySaleDto } from './dto/query-sale.dto';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private mail: MailService,
  ) {}

  /** Email a sale's receipt to the customer (or an explicit address). */
  async emailReceipt(businessId: string, saleId: string, overrideEmail?: string) {
    const sale = await this.findOne(businessId, saleId);
    const to = overrideEmail || sale.customer?.email;
    if (!to) {
      throw new BadRequestException(
        'No email address — add one to the customer or provide one.',
      );
    }
    await this.mail.sendReceipt(to, {
      customerName: sale.customer?.name ?? 'Customer',
      businessName: sale.business?.name ?? 'Your store',
      receiptNo: sale.receiptNo,
      date: sale.createdAt,
      currency: sale.business?.currency ?? 'USD',
      items: sale.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        lineTotal: Number(i.lineTotal),
      })),
      subtotal: Number(sale.subtotal),
      discount: Number(sale.discount),
      tax: Number(sale.tax),
      total: Number(sale.total),
    });
    return { message: `Receipt emailed to ${to}` };
  }

  async create(user: AuthUser, dto: CreateSaleDto) {
    const businessId = user.businessId;
    const storeId = dto.storeId ?? user.storeId;
    if (!storeId) {
      throw new BadRequestException('No store specified for this sale');
    }
    await this.assertStore(businessId, storeId);
    if (dto.customerId) await this.assertCustomer(businessId, dto.customerId);

    // Master tax switch: when off, no line charges tax regardless of product.
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { taxEnabled: true },
    });
    const taxEnabled = business?.taxEnabled ?? true;

    // Load all products in one go
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, businessId, isActive: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));
    if (productMap.size !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }

    // Pharmacy: block Rx items without a prescription reference
    const needsRx = dto.items.some((i) => productMap.get(i.productId)!.isRxRequired);
    if (needsRx && !dto.prescriptionRef) {
      throw new BadRequestException(
        'A prescription reference is required for prescription-only items',
      );
    }

    // ---- Compute totals ----
    const lines = dto.items.map((i) => {
      const product = productMap.get(i.productId)!;
      const unitPrice = i.unitPrice ?? Number(product.sellingPrice);
      const itemDiscount = i.discount ?? 0;
      const lineNet = round2(unitPrice * i.quantity - itemDiscount);
      if (lineNet < 0) throw new BadRequestException('Discount exceeds line total');
      // Tax applies only when the master switch is on AND the product is taxable.
      const taxRate = taxEnabled && product.isTaxable ? Number(product.taxRate) : 0;
      const lineTax = round2((lineNet * taxRate) / 100);
      return {
        productId: i.productId,
        name: product.name,
        quantity: i.quantity,
        unitPrice,
        unitCost: Number(product.costPrice), // snapshot for accurate profit later
        discount: itemDiscount,
        taxRate,
        lineNet,
        lineTax,
        lineTotal: round2(lineNet + lineTax),
        trackBatches: product.trackBatches,
      };
    });

    const subtotal = round2(lines.reduce((s, l) => s + l.lineNet, 0));
    const tax = round2(lines.reduce((s, l) => s + l.lineTax, 0));
    const billDiscount = dto.discount ?? 0;
    const total = round2(subtotal + tax - billDiscount);
    if (total < 0) throw new BadRequestException('Discount exceeds sale total');

    const requestedMethod = dto.paymentMethod ?? PaymentMethod.CASH;
    // How much is actually paid now. A CREDIT sale defaults to nothing paid;
    // otherwise the full total unless the caller passes a smaller amount.
    const rawPaid =
      dto.amountPaid ?? (requestedMethod === PaymentMethod.CREDIT ? 0 : total);
    const amountPaid = round2(Math.min(Math.max(rawPaid, 0), total));
    // Whatever is left becomes the customer's credit (their outstanding due).
    const creditDue = round2(total - amountPaid);
    if (creditDue > 0 && !dto.customerId) {
      throw new BadRequestException(
        'A customer is required when part of the sale is left on credit',
      );
    }
    // Record the real payment state: nothing paid -> CREDIT, part paid -> MIXED,
    // fully paid -> whatever tender the cashier chose (cash/card/mobile).
    const paymentMethod =
      creditDue > 0
        ? amountPaid > 0
          ? PaymentMethod.MIXED
          : PaymentMethod.CREDIT
        : requestedMethod;

    return this.prisma.$transaction(async (tx) => {
      const receiptNo = await this.nextReceiptNo(tx, businessId);

      const sale = await tx.sale.create({
        data: {
          businessId,
          storeId,
          userId: user.userId,
          customerId: dto.customerId,
          receiptNo,
          status: SaleStatus.COMPLETED,
          subtotal,
          discount: billDiscount,
          tax,
          total,
          paymentMethod,
          amountPaid,
          prescriptionRef: dto.prescriptionRef,
          note: dto.note,
          items: {
            create: lines.map((l) => ({
              productId: l.productId,
              name: l.name,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              unitCost: l.unitCost,
              discount: l.discount,
              taxRate: l.taxRate,
              lineTotal: l.lineTotal,
            })),
          },
        },
        include: { items: true },
      });

      // Deduct stock (blocks overselling) and consume batches FEFO
      for (const l of lines) {
        await this.inventory.applyMovement(tx, {
          businessId,
          storeId,
          productId: l.productId,
          type: StockMovementType.SALE,
          quantity: -l.quantity,
          userId: user.userId,
          reference: sale.id,
        });
        if (l.trackBatches) {
          await this.consumeBatchesFEFO(tx, storeId, l.productId, l.quantity);
        }
      }

      // Any unpaid remainder -> add to the customer's outstanding balance
      if (creditDue > 0 && dto.customerId) {
        await tx.customer.update({
          where: { id: dto.customerId },
          data: { creditBalance: { increment: creditDue } },
        });
      }

      return sale;
    }, TX_OPTS);
  }

  async returnItems(user: AuthUser, saleId: string, dto: ReturnSaleDto) {
    const businessId = user.businessId;
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    if (sale.status === SaleStatus.RETURNED) {
      throw new BadRequestException('Sale already fully returned');
    }

    const itemMap = new Map(sale.items.map((it) => [it.id, it]));
    let refund = 0;
    for (const r of dto.items) {
      const item = itemMap.get(r.saleItemId);
      if (!item) throw new BadRequestException('Invalid sale item');
      const returnable = item.quantity - item.returnedQty;
      if (r.quantity > returnable) {
        throw new BadRequestException(
          `Cannot return ${r.quantity} of "${item.name}" (only ${returnable} left)`,
        );
      }
      const perUnit = Number(item.lineTotal) / item.quantity;
      refund += perUnit * r.quantity;
    }
    refund = round2(refund);

    return this.prisma.$transaction(async (tx) => {
      for (const r of dto.items) {
        const item = itemMap.get(r.saleItemId)!;
        await this.inventory.applyMovement(
          tx,
          {
            businessId,
            storeId: sale.storeId,
            productId: item.productId,
            type: StockMovementType.RETURN_IN,
            quantity: r.quantity, // stock back in
            userId: user.userId,
            reference: sale.id,
          },
          { allowNegative: true },
        );
        await tx.saleItem.update({
          where: { id: item.id },
          data: { returnedQty: { increment: r.quantity } },
        });
      }

      // Fully vs partially returned?
      const updatedItems = await tx.saleItem.findMany({
        where: { saleId: sale.id },
      });
      const fullyReturned = updatedItems.every(
        (it) => it.returnedQty >= it.quantity,
      );

      // A refund first cancels whatever the customer still owes on this sale
      // (the unpaid/credit portion); only the rest is money handed back.
      // Settling it via the return raises amountPaid too, so a later return
      // on the same sale can't decrement the same credit twice.
      let creditReduction = 0;
      if (sale.customerId) {
        const outstanding = round2(
          Number(sale.total) - Number(sale.amountPaid),
        );
        creditReduction = Math.min(refund, Math.max(outstanding, 0));
        if (creditReduction > 0) {
          await tx.customer.update({
            where: { id: sale.customerId },
            data: { creditBalance: { decrement: creditReduction } },
          });
        }
      }

      const updated = await tx.sale.update({
        where: { id: sale.id },
        data: {
          ...(creditReduction > 0
            ? { amountPaid: { increment: creditReduction } }
            : {}),
          status: fullyReturned
            ? SaleStatus.RETURNED
            : SaleStatus.PARTIALLY_RETURNED,
        },
        include: { items: true },
      });
      return { sale: updated, refund };
    }, TX_OPTS);
  }

  async findAll(businessId: string, q: QuerySaleDto) {
    const where: Prisma.SaleWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
      ...(q.search ? { receiptNo: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.sale.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          customer: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.sale.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  async findOne(businessId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId },
      include: {
        items: true,
        customer: true,
        user: { select: { id: true, name: true } },
        store: { select: { id: true, name: true, address: true, phone: true } },
        business: {
          select: {
            name: true,
            currency: true,
            taxId: true,
            showTaxIdOnBill: true,
          },
        },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    return sale;
  }

  // ---- helpers ----

  /** Per-business sequential receipt number, e.g. INV-000042. */
  private async nextReceiptNo(tx: Prisma.TransactionClient, businessId: string) {
    const count = await tx.sale.count({ where: { businessId } });
    return `INV-${String(count + 1).padStart(6, '0')}`;
  }

  /** Reduce batch quantities oldest-expiry-first (First-Expired-First-Out). */
  private async consumeBatchesFEFO(
    tx: Prisma.TransactionClient,
    storeId: string,
    productId: string,
    quantity: number,
  ) {
    let remaining = quantity;
    const batches = await tx.batch.findMany({
      where: { storeId, productId, quantity: { gt: 0 } },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });
    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      await tx.batch.update({
        where: { id: batch.id },
        data: { quantity: { decrement: take } },
      });
      remaining -= take;
    }
    // If batches don't cover it, StockItem remains the source of truth; we
    // don't block the sale on batch bookkeeping.
  }

  private async assertStore(businessId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId },
    });
    if (!store) throw new BadRequestException('Invalid store');
  }

  private async assertCustomer(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, businessId },
    });
    if (!customer) throw new BadRequestException('Invalid customer');
  }
}
