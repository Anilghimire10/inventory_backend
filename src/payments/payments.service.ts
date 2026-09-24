import { Injectable } from '@nestjs/common';
import { PaymentMethod, PaymentType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Types where money comes towards the business. The rest move it away. */
const CASH_IN: PaymentType[] = [
  PaymentType.SALE,
  PaymentType.CUSTOMER_CREDIT,
  PaymentType.SUPPLIER_REFUND,
];

/** Tenders that move physical notes, and so touch a drawer. */
const CASH_TENDERS: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.MIXED];

/**
 * Tenders a balance can be settled with. Paying a khata "on credit" is
 * meaningless, and MIXED would count the whole amount towards the drawer.
 */
export const SETTLE_METHODS: PaymentMethod[] = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.MOBILE,
];

/** `+1` when the type brings money in, `-1` when it takes money out. */
export const paymentDirection = (type: PaymentType) =>
  CASH_IN.includes(type) ? 1 : -1;

export interface RecordPaymentInput {
  businessId: string;
  type: PaymentType;
  /** Always positive — what changed hands. Direction comes from `type`. */
  amount: number;
  method: PaymentMethod;
  storeId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  saleId?: string | null;
  purchaseId?: string | null;
  shiftId?: string | null;
  userId?: string | null;
  note?: string | null;
}

/**
 * The record of money moving.
 *
 * Every path that changes a balance writes one of these, in the same
 * transaction as the balance change. That is the whole point: a ledger written
 * afterwards, or outside the transaction, is one that disagrees with the
 * balance the moment anything fails halfway.
 *
 * Balances were deliberately not made derived. `Customer.creditBalance` and
 * `Purchase.amountPaid` are read on hot paths and defended by atomic guarded
 * statements — `WHERE creditBalance >= amount` is what stops two concurrent
 * payments driving a balance negative, and summing a ledger cannot express
 * that. So they stay authoritative, and this makes them *reconcilable*: for
 * any party, the balance should equal what the rows here say it should.
 */
@Injectable()
export class PaymentsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Write one payment row.
   *
   * Takes an optional transaction client because almost every caller is
   * already inside one — the row and the balance it explains must commit or
   * roll back together.
   */
  async record(input: RecordPaymentInput, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    return db.payment.create({
      data: {
        businessId: input.businessId,
        type: input.type,
        amount: round2(Math.abs(input.amount)),
        method: input.method,
        storeId: input.storeId ?? null,
        customerId: input.customerId ?? null,
        supplierId: input.supplierId ?? null,
        saleId: input.saleId ?? null,
        purchaseId: input.purchaseId ?? null,
        shiftId: input.shiftId ?? null,
        userId: input.userId ?? null,
        note: input.note ?? null,
      },
    });
  }

  /**
   * Cash taken at a till against customer credit, for one shift.
   *
   * The gap this closes: a customer settling their udhaaro in cash at the
   * counter put notes in the drawer that `expectedCash` knew nothing about,
   * because that figure was built from sales alone. Every such shift counted
   * long by exactly the credit collected, and the variance report blamed the
   * cashier.
   *
   * Only cash tenders. Paying a khata by card or QR moves the balance without
   * touching the drawer.
   */
  async cashCollectedOnShift(shiftId: string): Promise<number> {
    const agg = await this.prisma.payment.aggregate({
      where: {
        shiftId,
        type: PaymentType.CUSTOMER_CREDIT,
        method: { in: CASH_TENDERS },
      },
      _sum: { amount: true },
    });
    return round2(Number(agg._sum.amount ?? 0));
  }

  /**
   * One party's payment history, oldest first.
   *
   * The statement side of the ledger: what this customer or supplier has
   * actually handed over or been paid, with the date, the method and who took
   * it. Charges (credit sales, purchase invoices) are not payments and live on
   * `Sale` / `Purchase`; `customerStatement` below joins the two.
   */
  async forParty(
    businessId: string,
    party: { customerId?: string; supplierId?: string },
    opts: { from?: Date; to?: Date } = {},
  ) {
    const where: Prisma.PaymentWhereInput = {
      businessId,
      ...(party.customerId ? { customerId: party.customerId } : {}),
      ...(party.supplierId ? { supplierId: party.supplierId } : {}),
      ...(opts.from || opts.to
        ? {
            createdAt: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
    };

    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        amount: true,
        method: true,
        note: true,
        createdAt: true,
        saleId: true,
        purchaseId: true,
        user: { select: { id: true, name: true } },
        store: { select: { id: true, name: true } },
      },
    });

    return rows.map((r) => ({
      ...r,
      amount: round2(Number(r.amount)),
      /** +1 money in, -1 money out — so a caller never has to know the types. */
      direction: paymentDirection(r.type),
    }));
  }

  /**
   * A customer's account, reconstructed rather than read off a balance.
   *
   * Credit sales are what they were charged; payments are what they handed
   * over. Rather than claim those two must add up to the stored balance --
   * they cannot, for any account that existed before this ledger did -- the
   * difference is reported as `openingBalance`: the part of what they owe
   * that no recorded event explains.
   *
   * That makes the statement add up by construction, for every account:
   *
   *     openingBalance + charged - paid === stored
   *
   * and turns the interesting question into how big `openingBalance` is. Zero
   * means the whole account is reconstructable from events. Non-zero means a
   * balance carried in from before the ledger, a seeded figure, or a manual
   * adjustment -- worth showing on the statement as one line rather than
   * quietly absorbing into a total nobody can then explain.
   */
  async customerStatement(businessId: string, customerId: string) {
    const [customer, payments, credited] = await Promise.all([
      this.prisma.customer.findFirstOrThrow({
        where: { id: customerId, businessId },
        select: { id: true, name: true, phone: true, creditBalance: true },
      }),
      this.forParty(businessId, { customerId }),
      // What was put on the khata: the unpaid part of every credit sale.
      this.prisma.sale.findMany({
        where: {
          businessId,
          customerId,
          paymentMethod: { in: [PaymentMethod.CREDIT, PaymentMethod.MIXED] },
          status: { not: 'HELD' },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          receiptNo: true,
          createdAt: true,
          total: true,
          amountPaid: true,
        },
      }),
    ]);

    const charges = credited
      .map((s) => ({
        saleId: s.id,
        receiptNo: s.receiptNo,
        createdAt: s.createdAt,
        /**
         * What this sale still has on the khata: the part not paid up front,
         * less whatever a return cancelled. A return that cancels credit
         * raises `amountPaid` by exactly that amount (see
         * `SalesService.returnItems`), so `total - amountPaid` already nets it
         * out. `refundedTotal` must not be subtracted as well -- it also
         * carries that same cancelled credit, and would count it twice.
         */
        amount: round2(Number(s.total) - Number(s.amountPaid)),
      }))
      .filter((c) => c.amount > 0);

    const charged = round2(charges.reduce((sum, c) => sum + c.amount, 0));
    const paid = round2(
      payments
        .filter((p) => p.type === PaymentType.CUSTOMER_CREDIT)
        .reduce((sum, p) => sum + p.amount, 0),
    );
    const stored = round2(Number(customer.creditBalance));
    // Whatever the events don't account for. Solved for rather than compared
    // against, so the statement always balances and the unexplained part is
    // named instead of being a discrepancy the reader has to notice.
    const openingBalance = round2(stored - charged + paid);

    return {
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      openingBalance,
      charges,
      payments,
      totals: {
        openingBalance,
        charged,
        paid,
        /** openingBalance + charged - paid, which is `stored` by construction. */
        closing: round2(openingBalance + charged - paid),
        stored,
      },
      /**
       * True when every rupee owed is explained by a recorded sale or payment.
       * False means there is an opening balance -- normal for any account that
       * predates the ledger, and not by itself a fault.
       */
      reconciles: Math.abs(openingBalance) < 0.01,
    };
  }
}
