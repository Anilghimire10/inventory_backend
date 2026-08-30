import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
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
import { CreateSaleDto, SaleItemDto } from './dto/create-sale.dto';
import { HoldSaleDto } from './dto/hold-sale.dto';
import { ReturnSaleDto } from './dto/return-sale.dto';
import { QuerySaleDto } from './dto/query-sale.dto';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';

/** Fields `create()` and `hold()` share to price out a cart. */
interface SaleLinesInput {
  customerId?: string;
  items: SaleItemDto[];
  discount?: number;
  prescriptionRef?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Quantities are numeric(12,3) — keep float arithmetic on that grid. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

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
        quantity: Number(i.quantity),
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
    // Priced-out cart and the cashier's open till session (if any) — the
    // sale is stamped with it so the shift's Z report can reconcile cash.
    const [{ lines, subtotal, tax, billDiscount, total }, openShift] =
      await Promise.all([
        this.buildLines(businessId, storeId, dto),
        this.prisma.shift.findFirst({
          where: { businessId, userId: user.userId, closedAt: null },
          select: { id: true },
        }),
      ]);

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

    return this.createWithReceiptRetry(async () => this.prisma.$transaction(async (tx) => {
      const receiptNo = await this.nextReceiptNo(tx, businessId);

      const sale = await tx.sale.create({
        data: {
          businessId,
          storeId,
          userId: user.userId,
          customerId: dto.customerId,
          shiftId: openShift?.id ?? null,
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

      // Deduct stock (blocks overselling) and consume batches FEFO -- batched
      // so an N-line sale costs a handful of round trips, not O(N).
      await this.inventory.applyMovementsBatch(
        tx,
        lines.map((l) => ({
          businessId,
          storeId,
          productId: l.productId,
          type: StockMovementType.SALE,
          quantity: -l.quantity,
          userId: user.userId,
          reference: sale.id,
        })),
      );
      const batchTracked = lines.filter((l) => l.trackBatches);
      if (batchTracked.length) {
        await this.consumeBatchesFEFOBatch(
          tx,
          storeId,
          batchTracked.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        );
      }

      // Any unpaid remainder -> add to the customer's outstanding balance
      if (creditDue > 0 && dto.customerId) {
        await tx.customer.update({
          where: { id: dto.customerId },
          data: { creditBalance: { increment: creditDue } },
        });
      }

      return sale;
    }, TX_OPTS));
  }

  /**
   * nextReceiptNo() derives the next number from a plain COUNT with no
   * locking, so two checkouts for the same business at the same instant can
   * compute the same receipt number -- the second's insert then hits the
   * (businessId, receiptNo) unique constraint. Rather than lock/serialize
   * every checkout for that, just retry: recomputing the count and
   * re-running the transaction on the rare collision is cheap and keeps the
   * common case fully concurrent.
   */
  private async createWithReceiptRetry<T>(run: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        const isReceiptCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          JSON.stringify(err.meta?.target ?? '').includes('receiptNo');
        if (!isReceiptCollision || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
  }

  /**
   * Park a cart server-side: a HELD sale row that deducts no stock and,
   * unlike `create()`, never calls `nextReceiptNo()` -- its receipt slot is
   * a UUID placeholder so parking and discarding sales never creates gaps
   * in the real INV-###### sequence.
   */
  async hold(user: AuthUser, dto: HoldSaleDto) {
    const businessId = user.businessId;
    const storeId = dto.storeId ?? user.storeId;
    if (!storeId) {
      throw new BadRequestException('No store specified for this sale');
    }
    const { lines, subtotal, tax, billDiscount, total } = await this.buildLines(
      businessId,
      storeId,
      dto,
    );

    return this.prisma.sale.create({
      data: {
        businessId,
        storeId,
        userId: user.userId,
        customerId: dto.customerId,
        receiptNo: `HOLD-${randomUUID()}`,
        status: SaleStatus.HELD,
        subtotal,
        discount: billDiscount,
        tax,
        total,
        paymentMethod: PaymentMethod.CASH,
        amountPaid: 0,
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
  }

  /**
   * Hand a held sale's cart back to the caller and remove the parked row.
   * Nothing here is a real sale yet -- the client re-submits the returned
   * cart through `create()` to actually check out.
   */
  async resumeHeld(businessId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId, status: SaleStatus.HELD },
      include: { items: { include: { product: true } } },
    });
    if (!sale) throw new NotFoundException('Held sale not found');

    await this.prisma.sale.delete({ where: { id: sale.id } });

    return {
      storeId: sale.storeId,
      customerId: sale.customerId,
      discount: Number(sale.discount),
      prescriptionRef: sale.prescriptionRef,
      note: sale.note,
      items: sale.items.map((i) => {
        // The snapshotted unitPrice is always populated (it defaults to the
        // product's price at hold time), so only surface it as an "override"
        // when it actually diverges from the product's current price --
        // otherwise every resumed line would wrongly show as price-adjusted.
        const unitPrice = Number(i.unitPrice);
        const currentPrice = Number(i.product.sellingPrice);
        return {
          product: i.product,
          quantity: Number(i.quantity),
          unitPrice: unitPrice !== currentPrice ? unitPrice : undefined,
          discount: Number(i.discount) || undefined,
        };
      }),
    };
  }

  /** Discard a parked sale without resuming it. */
  async discardHeld(businessId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId, status: SaleStatus.HELD },
    });
    if (!sale) throw new NotFoundException('Held sale not found');
    await this.prisma.sale.delete({ where: { id: sale.id } });
    return { message: 'Held sale discarded' };
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
      const quantity = Number(item.quantity);
      const returnable = round3(quantity - Number(item.returnedQty));
      if (r.quantity > returnable) {
        throw new BadRequestException(
          `Cannot return ${r.quantity} of "${item.name}" (only ${returnable} left)`,
        );
      }
      const perUnit = Number(item.lineTotal) / quantity;
      refund += perUnit * r.quantity;
    }
    refund = round2(refund);

    return this.prisma.$transaction(async (tx) => {
      // Stock-back-in is batched (one read + one bulk write for all lines);
      // the returnedQty bumps stay per-row so duplicate saleItemIds in one
      // request still accumulate correctly via the DB-level increment.
      await this.inventory.applyMovementsBatch(
        tx,
        dto.items.map((r) => {
          const item = itemMap.get(r.saleItemId)!;
          return {
            businessId,
            storeId: sale.storeId,
            productId: item.productId,
            type: StockMovementType.RETURN_IN,
            quantity: r.quantity, // stock back in
            userId: user.userId,
            reference: sale.id,
          };
        }),
        { allowNegative: true },
      );
      for (const r of dto.items) {
        const item = itemMap.get(r.saleItemId)!;
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
    const RETURNS = [SaleStatus.RETURNED, SaleStatus.PARTIALLY_RETURNED];
    const NOT_RETURNED_HELD = { notIn: [...RETURNS, SaleStatus.HELD] };
    const statusWhere =
      q.status === 'return'
        ? { status: { in: RETURNS } }
        : q.status === 'held'
          ? { status: SaleStatus.HELD }
          : q.status === 'due'
            ? { status: NOT_RETURNED_HELD, paymentMethod: PaymentMethod.CREDIT }
            : q.status === 'partial'
              ? { status: NOT_RETURNED_HELD, paymentMethod: PaymentMethod.MIXED }
              : q.status === 'paid'
                ? {
                    status: NOT_RETURNED_HELD,
                    paymentMethod: { notIn: [PaymentMethod.CREDIT, PaymentMethod.MIXED] },
                  }
                : {};

    const where: Prisma.SaleWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.paymentMethod ? { paymentMethod: q.paymentMethod } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
      ...(q.search ? { receiptNo: { contains: q.search, mode: 'insensitive' } } : {}),
      ...statusWhere,
    };
    // Revenue is a fixed KPI, independent of whatever status filter the list
    // is currently showing -- always exclude returns/holds so it can't
    // include a returned sale's total just because the user filtered by
    // payment method, date range, etc. (matches reports.dashboard()).
    const revenueWhere: Prisma.SaleWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.paymentMethod ? { paymentMethod: q.paymentMethod } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
      ...(q.search ? { receiptNo: { contains: q.search, mode: 'insensitive' } } : {}),
      status: {
        notIn: [SaleStatus.RETURNED, SaleStatus.PARTIALLY_RETURNED, SaleStatus.HELD],
      },
    };
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayWhere: Prisma.SaleWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      createdAt: { gte: startOfToday },
      status: {
        notIn: [SaleStatus.RETURNED, SaleStatus.PARTIALLY_RETURNED, SaleStatus.HELD],
      },
    };

    const [data, total, agg, today] = await Promise.all([
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
      this.prisma.sale.aggregate({ where: revenueWhere, _sum: { total: true } }),
      this.prisma.sale.aggregate({ where: todayWhere, _sum: { total: true }, _count: true }),
    ]);
    const result = paginate(data, total, q.page, q.limit);
    result.meta.revenue = Number(agg._sum.total ?? 0);
    result.meta.todayRevenue = Number(today._sum.total ?? 0);
    result.meta.todayCount = today._count;
    return result;
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

  /**
   * Reduce batch quantities oldest-expiry-first (First-Expired-First-Out)
   * for every batch-tracked line in one shot: one read for all products'
   * batches, then a single bulk write for every batch touched, instead of
   * a read + N updates per line.
   */
  private async consumeBatchesFEFOBatch(
    tx: Prisma.TransactionClient,
    storeId: string,
    items: { productId: string; quantity: number }[],
  ) {
    if (items.length === 0) return;
    const productIds = items.map((i) => i.productId);
    const batches = await tx.batch.findMany({
      where: { storeId, productId: { in: productIds }, quantity: { gt: 0 } },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'asc' }],
    });
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
    await tx.$executeRaw`
      UPDATE "Batch" AS b
      SET quantity = v.qty::numeric
      FROM (SELECT * FROM UNNEST(${updateIds}::text[], ${updateQtys}::text[])) AS v(id, qty)
      WHERE b.id = v.id
    `;
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

  /** Validate + price out a cart. Shared by `create()` and `hold()`. */
  private async buildLines(
    businessId: string,
    storeId: string,
    dto: SaleLinesInput,
  ) {
    // Independent reads -- run concurrently instead of one round trip each.
    const productIds = dto.items.map((i) => i.productId);
    const [, , business, products] = await Promise.all([
      this.assertStore(businessId, storeId),
      dto.customerId
        ? this.assertCustomer(businessId, dto.customerId)
        : Promise.resolve(),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { taxEnabled: true },
      }),
      this.prisma.product.findMany({
        where: { id: { in: productIds }, businessId, isActive: true },
      }),
    ]);
    // Master tax switch: when off, no line charges tax regardless of product.
    const taxEnabled = business?.taxEnabled ?? true;
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

    return { lines, subtotal, tax, billDiscount, total };
  }
}
