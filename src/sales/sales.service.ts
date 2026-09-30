import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AdjustmentReason,
  BusinessType,
  PaymentMethod,
  PaymentType,
  Prisma,
  SaleStatus,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ShiftsService } from '../shifts/shifts.service';
import { PaymentsService, SETTLE_METHODS } from '../payments/payments.service';
import { InventoryService } from '../inventory/inventory.service';
import { MailService } from '../mail/mail.service';
import { AuthUser } from '../common/types/auth-user';
import { CreateSaleDto, SaleItemDto } from './dto/create-sale.dto';
import { HoldSaleDto } from './dto/hold-sale.dto';
import { ReturnSaleDto } from './dto/return-sale.dto';
import { QuerySaleDto } from './dto/query-sale.dto';
import { paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';
import { splitTax } from '../common/tax';
import { lineRefund, returnRefund } from '../common/refund';
import { assertOwnStore } from '../common/store-scope';
import { expiredCutoff, isExpired } from '../common/expiry';

/** Fields `create()` and `hold()` share to price out a cart. */
interface SaleLinesInput {
  customerId?: string;
  items: SaleItemDto[];
  discount?: number;
  prescriptionRef?: string;
}

/** A Prisma client or an active transaction client. */
type Db = PrismaService | Prisma.TransactionClient;

/** One line of a return: which sale line, and how much of it comes back. */
export interface ReturnLine {
  saleItemId: string;
  quantity: number;
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
    private shifts: ShiftsService,
    private payments: PaymentsService,
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
      taxInclusive: sale.taxInclusive,
    }, businessId);
    return { message: `Receipt emailed to ${to}` };
  }

  async create(user: AuthUser, dto: CreateSaleDto) {
    const businessId = user.businessId;
    const storeId = dto.storeId ?? user.storeId;
    if (!storeId) {
      throw new BadRequestException('No store specified for this sale');
    }
    // Priced-out cart and the till this sale belongs to (if any) — the sale
    // is stamped with it so the shift's Z report can reconcile cash.
    //
    // Resolved through ShiftsService so the drawer a sale lands in is decided
    // by exactly the rule the POS used to decide which till to show. That
    // includes an owner or manager joining the cashier's open shift: the
    // owner selling from the same physical till puts cash in the same drawer,
    // so it has to reconcile there.
    //
    // The `storeId` filter is new and is a fix in its own right: this looked
    // up the caller's open shift by user alone, so an owner with tills open at
    // two branches could ring up a sale at one and have it stamped onto the
    // other branch's drawer. Both Z reports were then wrong, and neither had
    // anything in it to show why.
    const [{ lines, subtotal, tax, billDiscount, total, taxInclusive, businessType }, shiftId] =
      await Promise.all([
        this.buildLines(businessId, storeId, dto),
        this.shifts.resolveShiftId(user, storeId, dto.shiftId),
      ]);

    // A pharmacy can't sell expired stock. Other shops get a warning at the
    // till and may go ahead; this is the one place that refuses outright.
    if (businessType === BusinessType.PHARMACY) {
      await this.assertInDate(storeId, lines);
    }

    // Serialised goods: one scanned serial per unit, checked before the
    // transaction so a bad scan never half-writes a sale.
    const serialLines = lines
      .filter((l) => l.trackSerials)
      .map((l) => ({
        productId: l.productId,
        serials: InventoryService.checkSerials(
          { name: l.name, trackSerials: true },
          l.quantity,
          l.serials,
        ),
      }));
    for (const l of lines.filter((l) => !l.trackSerials)) {
      InventoryService.checkSerials(
        { name: l.name, trackSerials: false },
        l.quantity,
        l.serials,
      );
    }

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
    // How the part paid now was actually handed over. The sale says MIXED
    // for "part paid, part owed", but MIXED is not a tender: booked that way,
    // a card part-payment was counted into the drawer as cash and the
    // cashier came up short at close by exactly that much. So the payment row
    // carries the tender the cashier picked; one that names no tender (CREDIT
    // with something paid, or a legacy MIXED) is cash, the counter default.
    const tender = SETTLE_METHODS.includes(requestedMethod)
      ? requestedMethod
      : PaymentMethod.CASH;

    return this.createWithReceiptRetry(async () => this.prisma.$transaction(async (tx) => {
      const receiptNo = await this.nextReceiptNo(tx, businessId);

      const sale = await tx.sale.create({
        data: {
          businessId,
          storeId,
          userId: user.userId,
          customerId: dto.customerId,
          shiftId,
          receiptNo,
          status: SaleStatus.COMPLETED,
          subtotal,
          discount: billDiscount,
          tax,
          total,
          taxInclusive,
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

      // What the customer actually handed over now. A fully-credit sale hands
      // over nothing, so it gets no row -- the debt is the sale, not a
      // payment, and inventing a zero payment would put an empty line on
      // every statement.
      if (amountPaid > 0) {
        await this.payments.record(
          {
            businessId,
            type: PaymentType.SALE,
            amount: amountPaid,
            method: tender,
            saleId: sale.id,
            customerId: dto.customerId ?? null,
            storeId,
            shiftId,
            userId: user.userId,
          },
          tx,
        );
      }

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
      for (const l of serialLines) {
        await this.inventory.sellSerials(tx, {
          businessId,
          storeId,
          productId: l.productId,
          saleId: sale.id,
          serials: l.serials,
        });
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
   * nextReceiptNo() reads the current max with no locking, so two checkouts
   * for the same business at the same instant can compute the same receipt
   * number -- the second's insert then hits the (businessId, receiptNo)
   * unique constraint. Rather than lock/serialize every checkout for that,
   * just retry: recomputing the max and re-running the transaction on the
   * rare collision is cheap and keeps the common case fully concurrent.
   *
   * Retries wait a short random time first. Retried at once, the checkouts
   * that collided recompute the same next number together and collide again:
   * ten fired at the same instant at one business failed a quarter of their
   * attempts outright with a 500 once the five tries ran out. Spread apart,
   * each finds the number the previous one took.
   */
  private async createWithReceiptRetry<T>(run: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 8;
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        const isReceiptCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          JSON.stringify(err.meta?.target ?? '').includes('receiptNo');
        if (!isReceiptCollision || attempt >= MAX_ATTEMPTS) throw err;
        const backoffMs = Math.random() * 40 * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
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
    const { lines, subtotal, tax, billDiscount, total, taxInclusive } = await this.buildLines(
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
        taxInclusive,
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

  /**
   * Check the lines of a return against the sale and value them: what the
   * goods are worth, and whether this brings the last unit back. Writes
   * nothing; the preview and the return both come through here and through
   * `splitRefund`, so what the cashier is shown before confirming is exactly
   * what happens.
   */
  private valueReturn(
    sale: Prisma.SaleGetPayload<{ include: { items: true } }>,
    lines: ReturnLine[],
  ) {
    const itemMap = new Map(sale.items.map((it) => [it.id, it]));
    // Per line, so the same line named twice in one request is checked
    // against its quantity as a whole rather than once per mention.
    const asked = new Map<string, number>();
    let itemsValue = 0;
    for (const r of lines) {
      const item = itemMap.get(r.saleItemId);
      if (!item) throw new BadRequestException('Invalid sale item');
      const total = round3((asked.get(item.id) ?? 0) + r.quantity);
      const returnable = round3(Number(item.quantity) - Number(item.returnedQty));
      if (total > returnable) {
        throw new BadRequestException(
          `Cannot return ${total} of "${item.name}" (only ${returnable} left)`,
        );
      }
      asked.set(item.id, total);
      itemsValue += lineRefund(sale, item, r.quantity);
    }
    // Numbers, not Decimals: Decimal comparison with >= compares strings,
    // and "2" >= "10" once flagged a part return as a full one.
    const closesSale = sale.items.every(
      (it) =>
        round3(Number(it.returnedQty) + (asked.get(it.id) ?? 0)) >=
        Number(it.quantity),
    );
    return { itemMap, closesSale, refund: returnRefund(sale, itemsValue, closesSale) };
  }

  /**
   * How a refund is paid: first by cancelling what the customer still owes on
   * this sale, the rest handed back.
   *
   * The credit cancelled is capped by the customer's balance as well as by
   * the sale. Paying a khata down lowers the balance without touching any one
   * sale's amountPaid, so a sale can look unpaid long after the customer
   * settled it; cancelling "its" credit then drove the balance negative and
   * handed back nothing for goods the customer had paid for in full.
   */
  private splitRefund(
    sale: { customerId: string | null; total: Prisma.Decimal; amountPaid: Prisma.Decimal },
    refund: number,
    customerBalance: number,
  ) {
    let creditCancelled = 0;
    if (sale.customerId) {
      const outstanding = round2(Number(sale.total) - Number(sale.amountPaid));
      creditCancelled = round2(
        Math.min(refund, Math.max(outstanding, 0), Math.max(customerBalance, 0)),
      );
    }
    return { creditCancelled, cashBack: round2(refund - creditCancelled) };
  }

  /** Refused before anything is read or written: nothing to take back. */
  private assertReturnable(status: SaleStatus) {
    // A held cart is not a sale: it never took stock off the shelf or money
    // into a drawer. "Returning" one put back stock that had never left and
    // recorded a refund of money never taken -- stock out of thin air.
    if (status === SaleStatus.HELD) {
      throw new BadRequestException(
        'A held cart is not a sale — resume or discard it instead',
      );
    }
    if (status === SaleStatus.RETURNED) {
      throw new BadRequestException('Sale already fully returned');
    }
  }

  /**
   * The tender a refund goes back on unless the cashier says otherwise: the
   * one the sale was paid with -- a card sale refunds to the card and leaves
   * the drawer alone -- and cash when the sale named no tender.
   */
  private async defaultRefundMethod(db: Db, saleId: string) {
    const paid = await db.payment.findFirst({
      where: { saleId, type: PaymentType.SALE },
      select: { method: true },
      orderBy: { createdAt: 'asc' },
    });
    return paid && SETTLE_METHODS.includes(paid.method)
      ? paid.method
      : PaymentMethod.CASH;
  }

  /** What a return would hand back, for the cashier to see before confirming. */
  async returnQuote(user: AuthUser, saleId: string, lines: ReturnLine[]) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId: user.businessId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    assertOwnStore(user, sale.storeId);
    this.assertReturnable(sale.status);
    const [balance, defaultMethod] = await Promise.all([
      sale.customerId
        ? this.prisma.customer
            .findUnique({
              where: { id: sale.customerId },
              select: { creditBalance: true },
            })
            .then((c) => Number(c?.creditBalance ?? 0))
        : Promise.resolve(0),
      this.defaultRefundMethod(this.prisma, sale.id),
    ]);
    const { refund, closesSale } = this.valueReturn(sale, lines);
    return { refund, ...this.splitRefund(sale, refund, balance), closesSale, defaultMethod };
  }

  /**
   * Take goods back against a sale and hand back what they were worth.
   *
   * Everything that decides the money is read inside the transaction, with
   * the sale and customer rows locked: the refund cap reads `refundedTotal`,
   * the credit cancelled reads the sale's unpaid part and the customer's
   * balance. Read before the transaction, two returns against the same sale
   * could both refund "what is left" of it, or both cancel the same credit.
   */
  async returnItems(user: AuthUser, saleId: string, dto: ReturnSaleDto) {
    const businessId = user.businessId;
    const found = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
      select: {
        id: true,
        storeId: true,
        status: true,
        items: { select: { productId: true } },
      },
    });
    if (!found) throw new NotFoundException('Sale not found');
    assertOwnStore(user, found.storeId);
    this.assertReturnable(found.status);

    const [trackedProducts, shiftId] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          id: { in: found.items.map((i) => i.productId) },
          businessId,
          OR: [{ trackSerials: true }, { trackBatches: true }],
        },
        select: { id: true, trackSerials: true, trackBatches: true },
      }),
      // The refund comes out of the drawer at the counter now, not the one the
      // sale was rung up on: a return a week later is paid from today's till,
      // and that till's count is the one it has to explain.
      this.shifts.resolveShiftId(user, found.storeId, dto.shiftId),
    ]);
    const serialised = new Set(trackedProducts.filter((p) => p.trackSerials).map((p) => p.id));
    const batched = new Set(trackedProducts.filter((p) => p.trackBatches).map((p) => p.id));

    return this.prisma.$transaction(async (tx) => {
      // One return per sale at a time. Everything below reads the sale after
      // this, so a return that was waiting sees the one before it in full.
      await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${found.id} FOR UPDATE`;
      const sale = await tx.sale.findUniqueOrThrow({
        where: { id: found.id },
        include: { items: true },
      });
      this.assertReturnable(sale.status);
      const { itemMap, refund, closesSale } = this.valueReturn(sale, dto.items);

      // Lock the customer before any stock row, the same order checkout
      // takes them in. Checkout's first write is the Sale row, whose foreign
      // key takes a share lock on the customer straight away; its stock rows
      // come after. Locking stock first here -- as this briefly did -- let a
      // return and a credit sale for the same customer and product each hold
      // one row the other needed, and Postgres broke the deadlock by failing
      // one with a 500 (found by firing both at once against a real database).
      let balance = 0;
      if (sale.customerId) {
        const [customer] = await tx.$queryRaw<{ creditBalance: Prisma.Decimal }[]>`
          SELECT "creditBalance" FROM "Customer" WHERE id = ${sale.customerId} FOR UPDATE
        `;
        balance = Number(customer?.creditBalance ?? 0);
      }
      const { creditCancelled, cashBack } = this.splitRefund(sale, refund, balance);

      // Stock-back-in is batched (one read + one bulk write for all lines).
      // Goods that came back damaged are booked in and written off in the
      // same batch: they never reach the shelf, and the history shows both
      // what came back and why it isn't there. Batched together, their net
      // change is zero, so the write-off can't fail for want of stock.
      const reason = dto.reason?.trim() || null;
      await this.inventory.applyMovementsBatch(
        tx,
        dto.items.flatMap((r) => {
          const item = itemMap.get(r.saleItemId)!;
          const back = {
            businessId,
            storeId: sale.storeId,
            productId: item.productId,
            userId: user.userId,
            reference: sale.id,
          };
          return [
            { ...back, type: StockMovementType.RETURN_IN, quantity: r.quantity, note: reason },
            ...(r.restock === false
              ? [
                  {
                    ...back,
                    type: StockMovementType.ADJUSTMENT,
                    quantity: -r.quantity,
                    reason: AdjustmentReason.DAMAGE,
                    note: reason ? `Returned damaged: ${reason}` : 'Returned damaged',
                  },
                ]
              : []),
          ];
        }),
        { allowNegative: true },
      );
      for (const r of dto.items) {
        const item = itemMap.get(r.saleItemId)!;
        // Guarded increment, evaluated against the row's live value at UPDATE
        // time. The sale lock above already serialises returns; this stays as
        // the last line of defence against a line being returned twice.
        const delta = String(round3(r.quantity));
        const bumped = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "SaleItem"
          SET "returnedQty" = "returnedQty" + ${delta}::numeric
          WHERE id = ${item.id}
            AND "returnedQty" + ${delta}::numeric <= quantity
          RETURNING id
        `;
        if (bumped.length === 0) {
          throw new BadRequestException(
            `Cannot return ${r.quantity} of "${item.name}" — it was returned by someone else just now`,
          );
        }
        if (serialised.has(item.productId)) {
          await this.inventory.returnSerialsToStock(tx, {
            businessId,
            storeId: sale.storeId,
            productId: item.productId,
            saleId: sale.id,
            quantity: r.quantity,
            serials: r.serials,
            damaged: r.restock === false,
          });
        }
        // Written-off goods never reach the shelf, so they rejoin no batch.
        if (batched.has(item.productId) && r.restock !== false) {
          await this.inventory.restoreBatchOnReturn(tx, {
            storeId: sale.storeId,
            productId: item.productId,
            quantity: r.quantity,
            soldAt: sale.createdAt,
          });
        }
      }

      // Credit first: that part never leaves the drawer, it just stops being
      // owed. Settling it via the return raises amountPaid too, so a later
      // return can't cancel the same credit twice.
      if (creditCancelled > 0) {
        await tx.customer.update({
          where: { id: sale.customerId! },
          data: { creditBalance: { decrement: creditCancelled } },
        });
      }

      // The rest is handed back, on the tender the cashier chose -- by default
      // the one the sale was paid with.
      let method: PaymentMethod | null = null;
      if (cashBack > 0) {
        method = dto.refundMethod ?? (await this.defaultRefundMethod(tx, sale.id));
        await this.payments.record(
          {
            businessId: sale.businessId,
            type: PaymentType.REFUND,
            amount: cashBack,
            method,
            saleId: sale.id,
            customerId: sale.customerId,
            storeId: sale.storeId,
            shiftId,
            userId: user.userId,
            note: reason,
          },
          tx,
        );
      }

      const updated = await tx.sale.update({
        where: { id: sale.id },
        data: {
          ...(creditCancelled > 0
            ? { amountPaid: { increment: creditCancelled } }
            : {}),
          // Revenue is total - refundedTotal, so this is what keeps a part
          // return out of the books without discarding the part that sold.
          refundedTotal: { increment: refund },
          status: closesSale
            ? SaleStatus.RETURNED
            : SaleStatus.PARTIALLY_RETURNED,
        },
        include: { items: true },
      });
      return {
        sale: updated,
        refund,
        creditCancelled,
        cashBack,
        method,
      };
    }, TX_OPTS);
  }

  /**
   * @param includeFinancials revenue KPIs are management-only (see
   * sales.controller.ts). Defaults true so internal callers keep the figures;
   * the HTTP route passes the caller's role explicitly.
   */
  /**
   * The sales a list filter matches -- shared by the Sales page and its
   * export, so the file holds exactly the bills the screen was showing.
   */
  private listWhere(businessId: string, q: QuerySaleDto): Prisma.SaleWhereInput {
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
    return {
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
  }

  /**
   * Every bill the filter matches, one row each, for the accountant: when,
   * receipt, branch, who rang it, customer, what was on it, and the money
   * -- before and after discounts, tax, refunds, what was paid and what is
   * still owed. Held carts only when asked for. Times are the shop's own.
   * Capped at 50,000 rows; `truncated` says when the filter matched more.
   */
  async exportRows(businessId: string, q: QuerySaleDto) {
    const CAP = 50_000;
    // A held cart isn't a sale: left out unless the filter asks for them.
    const base = this.listWhere(businessId, q);
    const where: Prisma.SaleWhereInput =
      q.status === 'held' ? base : { AND: [base, { status: { not: SaleStatus.HELD } }] };
    const [business, total, sales] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } }),
      this.prisma.sale.count({ where }),
      this.prisma.sale.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: CAP,
        select: {
          receiptNo: true,
          createdAt: true,
          status: true,
          paymentMethod: true,
          subtotal: true,
          discount: true,
          tax: true,
          total: true,
          refundedTotal: true,
          amountPaid: true,
          prescriptionRef: true,
          store: { select: { name: true } },
          user: { select: { name: true } },
          customer: { select: { name: true, phone: true } },
          items: { select: { name: true, quantity: true, discount: true } },
        },
      }),
    ]);
    const when = new Intl.DateTimeFormat('en-CA', {
      timeZone: business?.timezone || 'Asia/Kathmandu',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const STATUS: Record<SaleStatus, string> = {
      COMPLETED: 'Completed',
      HELD: 'On hold',
      RETURNED: 'Returned',
      PARTIALLY_RETURNED: 'Part returned',
    };
    const METHOD: Record<PaymentMethod, string> = {
      CASH: 'Cash',
      CARD: 'Card',
      MOBILE: 'QR / Mobile',
      KHALTI: 'Khalti',
      CONNECTIPS: 'connectIPS',
      CREDIT: 'On credit',
      MIXED: 'Part paid',
    };
    const rows = sales.map((s) => {
      const total = Number(s.total);
      const refunded = Number(s.refundedTotal);
      const paid = Number(s.amountPaid);
      const lineDiscounts = s.items.reduce((n, i) => n + Number(i.discount), 0);
      return {
        date: when.format(s.createdAt).replace(',', ''),
        receiptNo: s.receiptNo,
        store: s.store.name,
        cashier: s.user?.name ?? '',
        customer: s.customer?.name ?? 'Walk-in',
        customerPhone: s.customer?.phone ?? '',
        items: s.items.map((i) => `${i.name} x ${Number(i.quantity)}`).join('; '),
        units: round3(s.items.reduce((n, i) => n + Number(i.quantity), 0)),
        subtotal: Number(s.subtotal),
        discount: round2(Number(s.discount) + lineDiscounts),
        tax: Number(s.tax),
        total,
        refunded,
        netTotal: round2(total - refunded),
        paid,
        due: round2(Math.max(total - refunded - paid, 0)),
        paymentMethod: METHOD[s.paymentMethod],
        status: STATUS[s.status],
        prescriptionRef: s.prescriptionRef ?? '',
      };
    });
    return { rows, total, truncated: total > CAP };
  }

  async findAll(
    businessId: string,
    q: QuerySaleDto,
    includeFinancials = true,
  ) {
    const where = this.listWhere(businessId, q);
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
      // Only a held cart is not a sale. Returned and part-returned sales stay
      // in and are netted below via refundedTotal -- dropping them outright
      // made a sale with one item returned count as zero revenue.
      status: { notIn: [SaleStatus.HELD] },
    };
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayWhere: Prisma.SaleWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      createdAt: { gte: startOfToday },
      status: { notIn: [SaleStatus.HELD] },
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
      // Not just withheld from the response -- not queried at all, so a
      // cashier's list load costs two fewer aggregates over the whole table.
      includeFinancials
        ? this.prisma.sale.aggregate({
            where: revenueWhere,
            _sum: { total: true, refundedTotal: true },
            _count: true,
          })
        : Promise.resolve(null),
      includeFinancials
        ? this.prisma.sale.aggregate({
            where: todayWhere,
            _sum: { total: true, refundedTotal: true },
            _count: true,
          })
        : Promise.resolve(null),
    ]);
    const result = paginate(data, total, q.page, q.limit);
    if (agg && today) {
      /** What was rung up, less what was handed back on returns. */
      const netOf = (a: {
        _sum: { total: Prisma.Decimal | null; refundedTotal: Prisma.Decimal | null };
      }) => round2(Number(a._sum.total ?? 0) - Number(a._sum.refundedTotal ?? 0));
      result.meta.revenue = netOf(agg);
      // The number of sales that `revenue` is the sum of. Not the same as
      // meta.total, which counts whatever the list is showing -- returned and
      // held sales included. Without it an average sale value can't be worked
      // out from this response.
      result.meta.revenueCount = agg._count;
      result.meta.todayRevenue = netOf(today);
      result.meta.todayCount = today._count;
    }
    return result;
  }

  async findOne(businessId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, businessId },
      include: {
        items: true,
        // Serialised units that went out on this sale -- printed on the bill
        // and used for warranty lookups.
        serials: { select: { productId: true, serialNumber: true, status: true } },
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

  /**
   * Per-business sequential receipt number, e.g. INV-000042.
   *
   * Derived from the highest INV- number actually issued, not a row count --
   * a plain count drifts from the real sequence as soon as any row that
   * isn't a real receipt is created and later deleted (a held sale is a Sale
   * row too, and discarding/resuming one deletes it), permanently wedging
   * every future checkout on a repeatable unique-constraint collision.
   * Fixed-width zero-padding keeps lexicographic (`orderBy`) and numeric
   * order the same up to 999999 receipts.
   */
  private async nextReceiptNo(tx: Prisma.TransactionClient, businessId: string) {
    const last = await tx.sale.findFirst({
      where: { businessId, receiptNo: { startsWith: 'INV-' } },
      orderBy: { receiptNo: 'desc' },
      select: { receiptNo: true },
    });
    const next = last ? Number(last.receiptNo.slice(4)) + 1 : 1;
    return `INV-${String(next).padStart(6, '0')}`;
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
        select: { taxEnabled: true, taxInclusive: true, type: true },
      }),
      this.prisma.product.findMany({
        where: { id: { in: productIds }, businessId, isActive: true },
      }),
    ]);
    // Master tax switch: when off, no line charges tax regardless of product.
    const taxEnabled = business?.taxEnabled ?? true;
    // Whether shelf prices already contain their tax.
    const taxInclusive = business?.taxInclusive ?? false;
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
      const lineAmount = round2(unitPrice * i.quantity - itemDiscount);
      if (lineAmount < 0) throw new BadRequestException('Discount exceeds line total');
      // Tax applies only when the master switch is on AND the product is taxable.
      const taxRate = taxEnabled && product.isTaxable ? Number(product.taxRate) : 0;
      const { net: lineNet, tax: lineTax, total: lineTotal } = splitTax(
        lineAmount,
        taxRate,
        taxInclusive,
      );
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
        lineTotal,
        trackBatches: product.trackBatches,
        trackSerials: product.trackSerials,
        serials: i.serials,
        expiryDate: product.expiryDate,
      };
    });

    const subtotal = round2(lines.reduce((s, l) => s + l.lineNet, 0));
    const tax = round2(lines.reduce((s, l) => s + l.lineTax, 0));
    const billDiscount = dto.discount ?? 0;
    const total = round2(subtotal + tax - billDiscount);
    if (total < 0) throw new BadRequestException('Discount exceeds sale total');

    return { lines, subtotal, tax, billDiscount, total, taxInclusive, businessType: business?.type };
  }

  /**
   * Refuse a sale that would hand over expired stock: a product whose own
   * expiry date has passed, or more units of a batch-tracked product than
   * its in-date batches hold. Pharmacies only (see `create`).
   */
  private async assertInDate(
    storeId: string,
    lines: { productId: string; name: string; quantity: number; trackBatches: boolean; expiryDate: Date | null }[],
  ) {
    const now = new Date();
    for (const l of lines) {
      if (isExpired(l.expiryDate, now)) {
        throw new BadRequestException(
          `${l.name} expired on ${l.expiryDate!.toISOString().slice(0, 10)} and can't be sold. ` +
            'Write it off from Stock → Expiring.',
        );
      }
    }
    // One product can be on more than one line.
    const wanted = new Map<string, { name: string; qty: number }>();
    for (const l of lines.filter((l) => l.trackBatches)) {
      const w = wanted.get(l.productId) ?? { name: l.name, qty: 0 };
      w.qty = round3(w.qty + l.quantity);
      wanted.set(l.productId, w);
    }
    if (!wanted.size) return;
    const ids = [...wanted.keys()];
    const [stock, expired] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: { storeId, productId: { in: ids } },
        select: { productId: true, quantity: true },
      }),
      this.prisma.batch.groupBy({
        by: ['productId'],
        where: { storeId, productId: { in: ids }, quantity: { gt: 0 }, expiryDate: { lte: expiredCutoff(now) } },
        _sum: { quantity: true },
      }),
    ]);
    const onHand = new Map(stock.map((s) => [s.productId, Number(s.quantity)]));
    for (const e of expired) {
      const expiredQty = Number(e._sum.quantity ?? 0);
      if (expiredQty <= 0) continue;
      const w = wanted.get(e.productId)!;
      const inDate = Math.max(round3((onHand.get(e.productId) ?? 0) - expiredQty), 0);
      if (w.qty > inDate) {
        throw new BadRequestException(
          `Only ${inDate} of ${w.name} ${inDate === 1 ? 'is' : 'are'} in date; ${expiredQty} ` +
            `${expiredQty === 1 ? 'has' : 'have'} expired and can't be sold.`,
        );
      }
    }
  }
}
