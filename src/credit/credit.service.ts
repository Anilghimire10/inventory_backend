import { Injectable } from '@nestjs/common';
import { PurchaseStatus, PaymentMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class CreditService {
  constructor(private prisma: PrismaService) {}

  /** Headline totals for the Credit dashboard (all computed server-side). */
  async summary(businessId: string) {
    const [receivables, payables] = await Promise.all([
      this.receivables(businessId),
      this.payables(businessId),
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
    };
  }

  /**
   * Money customers owe us. One entry per customer with a positive credit
   * balance, plus their credit-sale invoices for context.
   */
  async receivables(businessId: string) {
    const customers = await this.prisma.customer.findMany({
      where: { businessId, creditBalance: { gt: 0 } },
      orderBy: { creditBalance: 'desc' },
      include: {
        sales: {
          where: { paymentMethod: PaymentMethod.CREDIT },
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
  async payables(businessId: string) {
    const purchases = await this.prisma.purchase.findMany({
      where: { businessId, status: { not: PurchaseStatus.CANCELLED } },
      orderBy: { createdAt: 'desc' },
      include: { supplier: { select: { id: true, name: true } } },
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
      if (outstanding <= 0.001) continue;

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
