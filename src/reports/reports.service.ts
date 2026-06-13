import { Injectable } from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  /** Home-screen snapshot: today's takings + alerts + value + best sellers. */
  async dashboard(businessId: string, storeId?: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const saleWhere = {
      businessId,
      ...(storeId ? { storeId } : {}),
    };

    const [today, lowStock, expiring, inventoryValue, topProducts] =
      await Promise.all([
        this.prisma.sale.aggregate({
          where: { ...saleWhere, createdAt: { gte: startOfToday } },
          _sum: { total: true },
          _count: true,
        }),
        this.inventory.lowStock(businessId, storeId),
        this.inventory.expiringBatches(businessId, { days: 30, storeId }),
        this.inventoryValue(businessId, storeId),
        this.topProducts(businessId, storeId, 5),
      ]);

    return {
      todaySalesTotal: Number(today._sum.total ?? 0),
      todaySalesCount: today._count,
      lowStockCount: lowStock.length,
      expiringSoonCount: expiring.length,
      inventoryValue,
      topProducts,
    };
  }

  /** Sales totals over a date range, with a per-day breakdown. */
  async salesSummary(
    businessId: string,
    opts: { from?: string; to?: string; storeId?: string },
  ) {
    const where = {
      businessId,
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
      status: { not: SaleStatus.HELD },
      ...(opts.from || opts.to
        ? {
            createdAt: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const sales = await this.prisma.sale.findMany({
      where,
      select: { total: true, tax: true, discount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const byDay: Record<string, { total: number; count: number }> = {};
    let revenue = 0;
    for (const s of sales) {
      const day = s.createdAt.toISOString().slice(0, 10);
      byDay[day] ??= { total: 0, count: 0 };
      byDay[day].total = Math.round((byDay[day].total + Number(s.total)) * 100) / 100;
      byDay[day].count += 1;
      revenue += Number(s.total);
    }

    return {
      count: sales.length,
      revenue: Math.round(revenue * 100) / 100,
      byDay: Object.entries(byDay).map(([date, v]) => ({ date, ...v })),
    };
  }

  /**
   * Full analytics for the Analytics page: totals (gross sales, net revenue,
   * cost, profit, margin), sales-by-item, by-day, and by-payment-method.
   *
   * Profit uses each product's CURRENT cost price (the schema doesn't snapshot
   * cost at sale time), and quantities are net of returns. Revenue here is
   * net of tax; "gross sales" is the customer-facing total incl. tax/discount.
   */
  async analytics(
    businessId: string,
    opts: { from?: string; to?: string; storeId?: string },
  ) {
    const saleWhere: Prisma.SaleWhereInput = {
      businessId,
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
      status: { not: SaleStatus.HELD },
      ...(opts.from || opts.to
        ? {
            createdAt: {
              ...(opts.from ? { gte: new Date(opts.from) } : {}),
              ...(opts.to ? { lte: new Date(opts.to) } : {}),
            },
          }
        : {}),
    };

    const [agg, byPaymentRaw, sales, items] = await Promise.all([
      this.prisma.sale.aggregate({
        where: saleWhere,
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.sale.groupBy({
        by: ['paymentMethod'],
        where: saleWhere,
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.sale.findMany({
        where: saleWhere,
        select: { total: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.saleItem.findMany({
        where: { sale: saleWhere },
        select: {
          productId: true,
          name: true,
          quantity: true,
          returnedQty: true,
          unitPrice: true,
          unitCost: true,
          product: { select: { costPrice: true } },
        },
      }),
    ]);

    // Sales by item (net of returns)
    const map = new Map<
      string,
      { productId: string; name: string; quantitySold: number; revenue: number; cost: number; profit: number }
    >();
    for (const it of items) {
      const soldQty = it.quantity - it.returnedQty;
      if (soldQty <= 0) continue;
      const revenue = soldQty * Number(it.unitPrice);
      // Prefer the cost snapshotted at sale time; fall back to current cost
      // for sales recorded before cost-snapshotting existed.
      const unitCost = Number(it.unitCost) || Number(it.product.costPrice);
      const cost = soldQty * unitCost;
      const cur =
        map.get(it.productId) ??
        { productId: it.productId, name: it.name, quantitySold: 0, revenue: 0, cost: 0, profit: 0 };
      cur.quantitySold += soldQty;
      cur.revenue += revenue;
      cur.cost += cost;
      cur.profit += revenue - cost;
      map.set(it.productId, cur);
    }
    const byProduct = [...map.values()]
      .map((p) => ({
        ...p,
        revenue: round2(p.revenue),
        cost: round2(p.cost),
        profit: round2(p.profit),
      }))
      .sort((a, b) => b.profit - a.profit);

    const netRevenue = round2(byProduct.reduce((s, p) => s + p.revenue, 0));
    const cost = round2(byProduct.reduce((s, p) => s + p.cost, 0));
    const profit = round2(netRevenue - cost);

    // By day
    const byDayMap: Record<string, { total: number; count: number }> = {};
    for (const s of sales) {
      const day = s.createdAt.toISOString().slice(0, 10);
      byDayMap[day] ??= { total: 0, count: 0 };
      byDayMap[day].total = round2(byDayMap[day].total + Number(s.total));
      byDayMap[day].count += 1;
    }

    return {
      totals: {
        transactions: agg._count,
        grossSales: round2(Number(agg._sum.total ?? 0)),
        netRevenue,
        cost,
        profit,
        margin: netRevenue > 0 ? round2((profit / netRevenue) * 100) : 0,
      },
      byProduct,
      byDay: Object.entries(byDayMap).map(([date, v]) => ({ date, ...v })),
      byPaymentMethod: byPaymentRaw.map((p) => ({
        method: p.paymentMethod,
        total: round2(Number(p._sum.total ?? 0)),
        count: p._count,
      })),
    };
  }

  // ---- helpers ----

  private async inventoryValue(businessId: string, storeId?: string) {
    const items = await this.prisma.stockItem.findMany({
      where: { businessId, ...(storeId ? { storeId } : {}) },
      select: { quantity: true, product: { select: { costPrice: true } } },
    });
    const value = items.reduce(
      (sum, it) => sum + it.quantity * Number(it.product.costPrice),
      0,
    );
    return Math.round(value * 100) / 100;
  }

  private async topProducts(businessId: string, storeId: string | undefined, take: number) {
    const grouped = await this.prisma.saleItem.groupBy({
      by: ['productId', 'name'],
      where: {
        sale: { businessId, ...(storeId ? { storeId } : {}) },
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take,
    });
    return grouped.map((g) => ({
      productId: g.productId,
      name: g.name,
      quantitySold: g._sum.quantity ?? 0,
    }));
  }
}
