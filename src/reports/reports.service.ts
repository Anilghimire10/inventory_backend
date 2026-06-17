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

  /**
   * Home-screen snapshot: today's takings + alerts + value + best sellers.
   * Financial figures are included only when `includeFinancials` is true
   * (owner). Other roles still see the operational widgets.
   */
  async dashboard(
    businessId: string,
    storeId?: string,
    includeFinancials = true,
  ) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const saleWhere = {
      businessId,
      ...(storeId ? { storeId } : {}),
    };

    const [today, lowStock, expiring, inventoryValue, topProducts, slowProducts] =
      await Promise.all([
        this.prisma.sale.aggregate({
          where: { ...saleWhere, createdAt: { gte: startOfToday } },
          _sum: { total: true },
          _count: true,
        }),
        this.inventory.lowStock(businessId, storeId),
        this.inventory.expiringBatches(businessId, { days: 30, storeId }),
        includeFinancials
          ? this.inventoryValue(businessId, storeId)
          : Promise.resolve(null),
        this.topProducts(businessId, storeId, 5),
        this.slowProducts(businessId, storeId, 5),
      ]);

    // Charts below are revenue-based, so owner-only.
    const [salesTrend, hourlyToday] = includeFinancials
      ? await Promise.all([
          this.salesTrend(businessId, storeId, 14),
          this.hourlyToday(businessId, storeId, startOfToday),
        ])
      : [undefined, undefined];

    return {
      todaySalesCount: today._count,
      lowStockCount: lowStock.length,
      expiringSoonCount: expiring.length,
      topProducts,
      slowProducts,
      // Owner-only financial figures + charts.
      ...(includeFinancials
        ? {
            todaySalesTotal: Number(today._sum.total ?? 0),
            inventoryValue,
            salesTrend,
            hourlyToday,
          }
        : {}),
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

  /**
   * VAT / tax report for a period: tax collected on sales, the taxable base,
   * and a per-rate breakdown. Computed from sale line items.
   */
  async taxReport(
    businessId: string,
    opts: { from?: string; to?: string; storeId?: string },
  ) {
    const items = await this.prisma.saleItem.findMany({
      where: {
        sale: {
          businessId,
          status: { not: SaleStatus.HELD },
          ...(opts.storeId ? { storeId: opts.storeId } : {}),
          ...(opts.from || opts.to
            ? {
                createdAt: {
                  ...(opts.from ? { gte: new Date(opts.from) } : {}),
                  ...(opts.to ? { lte: new Date(opts.to) } : {}),
                },
              }
            : {}),
        },
      },
      select: {
        quantity: true,
        returnedQty: true,
        unitPrice: true,
        discount: true,
        taxRate: true,
        lineTotal: true,
      },
    });

    const byRate = new Map<number, { taxableAmount: number; tax: number }>();
    let taxableAmount = 0;
    let taxCollected = 0;
    let grossSales = 0;

    for (const it of items) {
      const soldQty = it.quantity - it.returnedQty;
      if (soldQty <= 0) continue;
      const rate = Number(it.taxRate);
      // Net of the per-unit discount, scaled to the non-returned quantity.
      const perUnitNet =
        Number(it.unitPrice) - Number(it.discount) / (it.quantity || 1);
      const lineNet = perUnitNet * soldQty;
      const lineTax = round2((lineNet * rate) / 100);
      taxableAmount += lineNet;
      taxCollected += lineTax;
      grossSales += lineNet + lineTax;
      if (rate > 0) {
        const cur = byRate.get(rate) ?? { taxableAmount: 0, tax: 0 };
        cur.taxableAmount += lineNet;
        cur.tax += lineTax;
        byRate.set(rate, cur);
      }
    }

    return {
      taxableAmount: round2(taxableAmount),
      taxCollected: round2(taxCollected),
      grossSales: round2(grossSales),
      byRate: [...byRate.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([rate, v]) => ({
          rate,
          taxableAmount: round2(v.taxableAmount),
          tax: round2(v.tax),
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

  /**
   * Slowest-moving stocked products: active products with stock on hand,
   * ranked by units sold over the last 30 days (ascending). Surfaces items
   * that are tying up capital without selling.
   */
  private async slowProducts(
    businessId: string,
    storeId: string | undefined,
    take: number,
  ) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const [products, sold] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          businessId,
          isActive: true,
          stockItems: {
            some: { quantity: { gt: 0 }, ...(storeId ? { storeId } : {}) },
          },
        },
        select: {
          id: true,
          name: true,
          stockItems: {
            where: storeId ? { storeId } : {},
            select: { quantity: true },
          },
        },
      }),
      this.prisma.saleItem.groupBy({
        by: ['productId'],
        where: {
          sale: {
            businessId,
            ...(storeId ? { storeId } : {}),
            createdAt: { gte: since },
          },
        },
        _sum: { quantity: true },
      }),
    ]);

    const soldMap = new Map(sold.map((s) => [s.productId, s._sum.quantity ?? 0]));
    return products
      .map((p) => ({
        productId: p.id,
        name: p.name,
        quantitySold: soldMap.get(p.id) ?? 0,
        inStock: p.stockItems.reduce((s, si) => s + si.quantity, 0),
      }))
      .sort((a, b) => a.quantitySold - b.quantitySold || b.inStock - a.inStock)
      .slice(0, take);
  }

  /** Daily sales totals for the last `days` days (continuous, zero-filled). */
  private async salesTrend(
    businessId: string,
    storeId: string | undefined,
    days: number,
  ) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));

    const sales = await this.prisma.sale.findMany({
      where: {
        businessId,
        ...(storeId ? { storeId } : {}),
        status: { not: SaleStatus.HELD },
        createdAt: { gte: start },
      },
      select: { total: true, createdAt: true },
    });

    const byDay = new Map<string, { total: number; count: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      byDay.set(d.toISOString().slice(0, 10), { total: 0, count: 0 });
    }
    for (const s of sales) {
      const key = s.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(key);
      if (bucket) {
        bucket.total = round2(bucket.total + Number(s.total));
        bucket.count += 1;
      }
    }
    return [...byDay.entries()].map(([date, v]) => ({ date, ...v }));
  }

  /** Today's sales totals bucketed by hour (0–23, zero-filled). */
  private async hourlyToday(
    businessId: string,
    storeId: string | undefined,
    startOfToday: Date,
  ) {
    const sales = await this.prisma.sale.findMany({
      where: {
        businessId,
        ...(storeId ? { storeId } : {}),
        status: { not: SaleStatus.HELD },
        createdAt: { gte: startOfToday },
      },
      select: { total: true, createdAt: true },
    });

    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      total: 0,
      count: 0,
    }));
    for (const s of sales) {
      const h = s.createdAt.getHours();
      hours[h].total = round2(hours[h].total + Number(s.total));
      hours[h].count += 1;
    }
    return hours;
  }
}
