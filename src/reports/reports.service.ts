import { Injectable } from '@nestjs/common';
import { Prisma, SaleStatus, StockMovementType } from '@prisma/client';
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
    const { from, to } = opts;
    const saleWhere: Prisma.SaleWhereInput = {
      businessId,
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
      status: { not: SaleStatus.HELD },
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };

    // The equal-length window immediately before the selected one, for
    // % change on the KPI cards. Null when there's no finite start (All time).
    const prevWindow =
      from && to
        ? (() => {
            const len = new Date(to).getTime() - new Date(from).getTime();
            const prevTo = new Date(new Date(from).getTime() - 1);
            const prevFrom = new Date(prevTo.getTime() - len);
            return {
              from: prevFrom.toISOString(),
              to: prevTo.toISOString(),
            };
          })()
        : null;

    const [agg, byPaymentRaw, sales, items, prev] = await Promise.all([
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
          sale: { select: { createdAt: true } },
          product: {
            select: {
              costPrice: true,
              categories: { select: { name: true } },
            },
          },
        },
      }),
      prevWindow
        ? (async () => {
            const prevWhere: Prisma.SaleWhereInput = {
              businessId,
              ...(opts.storeId ? { storeId: opts.storeId } : {}),
              status: { not: SaleStatus.HELD },
              createdAt: {
                gte: new Date(prevWindow.from),
                lte: new Date(prevWindow.to),
              },
            };
            const [prevAgg, prevItems] = await Promise.all([
              this.prisma.sale.aggregate({
                where: prevWhere,
                _sum: { total: true },
                _count: true,
              }),
              this.prisma.saleItem.findMany({
                where: { sale: prevWhere },
                select: {
                  quantity: true,
                  returnedQty: true,
                  unitPrice: true,
                  unitCost: true,
                  product: { select: { costPrice: true } },
                },
              }),
            ]);
            const prevCost = prevItems.reduce(
              (s, it) =>
                s +
                (it.quantity - it.returnedQty) *
                  (Number(it.unitCost) || Number(it.product.costPrice)),
              0,
            );
            const prevRevenue = prevItems.reduce(
              (s, it) => s + (it.quantity - it.returnedQty) * Number(it.unitPrice),
              0,
            );
            return {
              revenue: round2(Number(prevAgg._sum.total ?? 0)),
              orders: prevAgg._count,
              netRevenue: round2(prevRevenue),
              profit: round2(prevRevenue - prevCost),
            };
          })()
        : Promise.resolve(null),
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

    // By day: revenue + order count (from sales) and units (from items)
    const byDayMap: Record<string, { total: number; count: number; units: number }> = {};
    for (const s of sales) {
      const day = s.createdAt.toISOString().slice(0, 10);
      byDayMap[day] ??= { total: 0, count: 0, units: 0 };
      byDayMap[day].total = round2(byDayMap[day].total + Number(s.total));
      byDayMap[day].count += 1;
    }
    for (const it of items) {
      const day = it.sale.createdAt.toISOString().slice(0, 10);
      const bucket = byDayMap[day];
      if (bucket) bucket.units += it.quantity - it.returnedQty;
    }

    // Sales by category (net of returns), attributed to the first category
    const catMap = new Map<string, { category: string; revenue: number; units: number }>();
    for (const it of items) {
      const soldQty = it.quantity - it.returnedQty;
      if (soldQty <= 0) continue;
      const category = it.product.categories[0]?.name ?? 'Uncategorized';
      const cur = catMap.get(category) ?? { category, revenue: 0, units: 0 };
      cur.revenue += soldQty * Number(it.unitPrice);
      cur.units += soldQty;
      catMap.set(category, cur);
    }
    const catTotal = [...catMap.values()].reduce((s, c) => s + c.revenue, 0) || 1;
    const byCategory = [...catMap.entries()]
      .map(([category, v]) => ({
        category,
        revenue: round2(v.revenue),
        units: v.units,
        share: round2((v.revenue / catTotal) * 100),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Hour-of-day buckets across the whole range
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, count: 0, units: 0 }));
    for (const s of sales) {
      const h = s.createdAt.getHours();
      hours[h].total = round2(hours[h].total + Number(s.total));
      hours[h].count += 1;
    }
    for (const it of items) {
      const h = it.sale.createdAt.getHours();
      hours[h].units += it.quantity - it.returnedQty;
    }

    // Payment methods with % share
    const payTotal = byPaymentRaw.reduce((s, p) => s + Number(p._sum.total ?? 0), 0) || 1;
    const byPaymentMethod = byPaymentRaw
      .map((p) => ({
        method: p.paymentMethod,
        total: round2(Number(p._sum.total ?? 0)),
        count: p._count,
        share: round2((Number(p._sum.total ?? 0) / payTotal) * 100),
      }))
      .sort((a, b) => b.total - a.total);

    // Inventory performance (across the selected period)
    const [inventoryValue, movements, needs] = await Promise.all([
      this.inventoryValue(businessId, opts.storeId),
      this.stockMovementDaily(businessId, opts.storeId, from, to),
      this.needsAttention(businessId, opts.storeId),
    ]);
    const totalUnits = byProduct.reduce((s, p) => s + p.quantitySold, 0);
    const stockTurnover =
      inventoryValue > 0 ? round2(cost / inventoryValue) : 0;
    const sellThrough =
      totalUnits + inventoryValue > 0
        ? Math.min(100, round2((totalUnits / (totalUnits + (inventoryValue / 10))) * 100))
        : 0;

    return {
      totals: {
        transactions: agg._count,
        grossSales: round2(Number(agg._sum.total ?? 0)),
        netRevenue,
        cost,
        profit,
        margin: netRevenue > 0 ? round2((profit / netRevenue) * 100) : 0,
        units: totalUnits,
      },
      comparison: prev
        ? {
            revenue: prev.revenue,
            orders: prev.orders,
            netRevenue: prev.netRevenue,
            profit: prev.profit,
          }
        : null,
      byProduct,
      byDay: Object.entries(byDayMap).map(([date, v]) => ({ date, ...v })),
      byCategory,
      byPaymentMethod,
      hourly: hours,
      inventory: {
        value: inventoryValue,
        stockTurnover,
        sellThrough,
        deadStockValue: round2(needs.deadStockValue),
        deadStockPct: needs.deadStockPct,
      },
      stockMovement: movements,
      needsAttention: {
        lowStock: needs.lowStock,
        unsold: needs.unsold,
        expiring: needs.expiring,
      },
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
          costPrice: true,
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
        costPrice: Number(p.costPrice),
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

  /**
   * Daily stock-movement buckets (purchases in, sales out, adjustments net)
   * plus a running closing-stock index for the selected window.
   */
  private async stockMovementDaily(
    businessId: string,
    storeId: string | undefined,
    from?: string,
    to?: string,
  ) {
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        businessId,
        ...(storeId ? { storeId } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      select: { type: true, quantity: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const byDay = new Map<
      string,
      { date: string; purchases: number; sales: number; adjustments: number }
    >();
    let closing = 0;
    const closingMap = new Map<string, number>();
    for (const m of movements) {
      const day = m.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { date: day, purchases: 0, sales: 0, adjustments: 0 };
      const qty = m.quantity;
      if (m.type === StockMovementType.PURCHASE) bucket.purchases += qty;
      else if (m.type === StockMovementType.SALE) bucket.sales += -qty;
      else bucket.adjustments += qty;
      closing += qty;
      byDay.set(day, bucket);
      closingMap.set(day, closing);
    }

    return [...byDay.entries()].map(([date, v]) => ({
      ...v,
      purchases: round2(v.purchases),
      sales: round2(v.sales),
      adjustments: round2(v.adjustments),
      closing: round2(closingMap.get(date) ?? 0),
    }));
  }

  /**
   * Alert counts for the "Needs attention" panel: products below their reorder
   * level, stocked products with zero sales in the last 30 days, and batches
   * expiring within 30 days (with the value of dead stock).
   */
  private async needsAttention(
    businessId: string,
    storeId: string | undefined,
  ) {
    const [lowStock, expiring, slow] = await Promise.all([
      this.inventory.lowStock(businessId, storeId),
      this.inventory.expiringBatches(businessId, { days: 30, storeId }),
      this.slowProducts(businessId, storeId, 5000),
    ]);
    const unsold = slow.filter((p) => p.quantitySold === 0);
    const deadStockValue = unsold.reduce(
      (s, p) => s + p.inStock * p.costPrice,
      0,
    );
    const inventoryValue = await this.inventoryValue(businessId, storeId);
    return {
      lowStock: lowStock.length,
      unsold: unsold.length,
      expiring: expiring.length,
      deadStockValue,
      deadStockPct:
        inventoryValue > 0 ? round2((deadStockValue / inventoryValue) * 100) : 0,
    };
  }
}
