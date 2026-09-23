import { Injectable } from '@nestjs/common';
import { PurchaseStatus, PaymentMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class CreditService {
  constructor(private prisma: PrismaService) {}

  /**
   * Headline totals for the Credit dashboard (all computed server-side).
   *
   * `storeId` does not mean the same thing on both sides, and the flag below
   * says so. Payables come from purchases, which carry a storeId, so they
   * scope exactly. Receivables come from Customer.creditBalance -- one number
   * per customer for the whole business, decremented by payCredit with no
   * store attribution -- so a branch's share of it cannot be derived. Filtered
   * by store it means "owed by customers who buy here", still in full.
   */
  async summary(businessId: string, storeId?: string) {
    const [receivables, payables] = await Promise.all([
      this.receivables(businessId, storeId),
      this.payables(businessId, storeId),
    ]);
    const receivablesTotal = round2(
      receivables.reduce((s, c) => s + c.balance, 0),
    );
    const payablesTotal = round2(
      payables.reduce((s, sup) => s + sup.outstanding, 0),
    );
    return {
      receivablesTotal,
      payablesTotal,
      netPosition: round2(receivablesTotal - payablesTotal),
      customersOwing: receivables.length,
      suppliersOwed: payables.length,
      /** True when receivablesTotal is a business-wide figure shown under a
       *  store filter, so the UI can label it rather than imply a branch total. */
      receivablesAreBusinessWide: !!storeId,
    };
  }

  /**
   * Money customers owe us. One entry per customer with a positive credit
   * balance, plus their credit-sale invoices for context.
   */
  async receivables(businessId: string, storeId?: string) {
    const creditSale = {
      paymentMethod: { in: [PaymentMethod.CREDIT, PaymentMethod.MIXED] },
      ...(storeId ? { storeId } : {}),
    };
    const customers = await this.prisma.customer.findMany({
      where: {
        businessId,
        creditBalance: { gt: 0 },
        // Under a store filter this narrows *which* customers appear, never
        // their balance: what they owe is owed to the business.
        ...(storeId ? { sales: { some: creditSale } } : {}),
      },
      orderBy: { creditBalance: 'desc' },
      include: {
        sales: {
          // The invoice list is context for the balance, so it follows the
          // filter even though the balance itself cannot.
          where: creditSale,
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            receiptNo: true,
            total: true,
            amountPaid: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    return customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      balance: round2(Number(c.creditBalance)),
      invoices: c.sales.map((s) => ({
        id: s.id,
        reference: s.receiptNo,
        total: round2(Number(s.total)),
        amountPaid: round2(Number(s.amountPaid)),
        status: s.status,
        createdAt: s.createdAt,
      })),
    }));
  }

  /**
   * Money we owe suppliers. One entry per supplier (plus an "unassigned"
   * bucket for supplier-less purchases) with the outstanding purchase invoices.
   */
  async payables(businessId: string, storeId?: string) {
    const purchases = await this.prisma.purchase.findMany({
      // Purchases carry a storeId, so this side scopes exactly.
      where: {
        businessId,
        status: { not: PurchaseStatus.CANCELLED },
        ...(storeId ? { storeId } : {}),
        // Only what is still owed. This used to load every non-cancelled
        // purchase the business had ever recorded and drop the settled ones
        // in JS -- and the settled ones are almost all of them, growing with
        // every invoice ever paid. `total` and `amountPaid` are Decimal(12,2),
        // so the comparison is exact and needs no epsilon.
        total: { gt: this.prisma.purchase.fields.amountPaid },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        total: true,
        amountPaid: true,
        status: true,
        createdAt: true,
        supplierId: true,
        supplier: { select: { id: true, name: true } },
      },
    });

    const groups = new Map<
      string,
      {
        id: string | null;
        name: string;
        outstanding: number;
        invoices: {
          id: string;
          reference: string | null;
          total: number;
          amountPaid: number;
          outstanding: number;
          status: PurchaseStatus;
          createdAt: Date;
        }[];
      }
    >();

    for (const p of purchases) {
      const outstanding = round2(Number(p.total) - Number(p.amountPaid));
      // The `total > amountPaid` filter already dropped the settled invoices;
      // this catches the one it can't -- a balance under half a paisa, which
      // rounds to zero here and would otherwise show as an invoice owing 0.
      if (outstanding <= 0) continue;

      const key = p.supplierId ?? '__none__';
      if (!groups.has(key)) {
        groups.set(key, {
          id: p.supplier?.id ?? null,
          name: p.supplier?.name ?? 'No supplier',
          outstanding: 0,
          invoices: [],
        });
      }
      const g = groups.get(key)!;
      g.outstanding = round2(g.outstanding + outstanding);
      g.invoices.push({
        id: p.id,
        reference: p.reference,
        total: round2(Number(p.total)),
        amountPaid: round2(Number(p.amountPaid)),
        outstanding,
        status: p.status,
        createdAt: p.createdAt,
      });
    }

    return [...groups.values()].sort((a, b) => b.outstanding - a.outstanding);
  }
}
