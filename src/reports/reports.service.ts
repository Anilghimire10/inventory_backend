import { Injectable } from '@nestjs/common';
import {
  AdjustmentReason,
  CashMovementReason,
  CashMovementType,
  PaymentMethod,
  PaymentType,
  Prisma,
  PurchaseStatus,
  SaleStatus,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { splitTax } from '../common/tax';
import { utcBound } from '../common/sql-time';
import {
  DEFAULT_TIMEZONE,
  addDays,
  dayKey,
  dayKeysBetween,
  startOfDay,
  startOfDayKey,
  type DayKey,
} from '../common/timezone';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A timestamp column read as a local wall-clock time in `tz`.
 *
 * Columns are `timestamp(3)` without a zone, holding UTC. `AT TIME ZONE 'UTC'`
 * says so explicitly, turning it into a `timestamptz`; the second
 * `AT TIME ZONE` then reads that instant off the shop's clock. Both halves are
 * needed -- one alone would reinterpret the value rather than convert it.
 */
const localTime = (col: Prisma.Sql, tz: string) =>
  Prisma.sql`(${col} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})`;

/** That local time as a `YYYY-MM-DD` day key, matching `dayKey()` in JS. */
const localDay = (col: Prisma.Sql, tz: string) =>
  Prisma.sql`to_char(${localTime(col, tz)}, 'YYYY-MM-DD')`;

/** That local time's hour of day, 0-23, matching `hourOfDay()` in JS. */
const localHour = (col: Prisma.Sql, tz: string) =>
  Prisma.sql`EXTRACT(HOUR FROM ${localTime(col, tz)})::int`;

/** Postgres returns SUM/COUNT as Decimal or BigInt; reports want numbers. */
const num = (v: Prisma.Decimal | bigint | number | null | undefined) =>
  Number(v ?? 0);

/**
 * The line-level arithmetic every sale rollup shares, written once.
 *
 * All three assume a query that joins `SaleItem si` to `Sale s`, and the cost
 * one also to `Product p`.
 */

/** Units on a line that were kept, i.e. not handed back. */
const SOLD_QTY = Prisma.sql`(si.quantity - si."returnedQty")`;

/**
 * What those units brought in, before tax and after every discount.
 *
 * Built the way the sale was: the line's amount less its own discount, with
 * tax backed out on a tax-inclusive sale (`taxRate` is 0 on untaxed lines,
 * where the factor is 1). That reproduces `Sale.subtotal` to the paisa. The
 * bill discount then comes off each line in proportion to its share of that
 * subtotal, which lands the sale on `subtotal - discount` -- what the shop
 * kept once tax is set aside. Only the kept share of the line counts.
 *
 * This used to be `kept units x unitPrice`, which left out both discounts:
 * every rupee knocked off at the till showed up as revenue and as profit.
 *
 * Not `lineTotal`: sales before tax-inclusive pricing stored it without tax
 * and later ones with it, so it means different things on different rows.
 */
const LINE_REVENUE = Prisma.sql`(${SOLD_QTY} / NULLIF(si.quantity, 0))
  * (si.quantity * si."unitPrice" - si.discount)
  * CASE WHEN s."taxInclusive" THEN 100 / (100 + si."taxRate") ELSE 1 END
  * CASE WHEN s.subtotal > 0 THEN GREATEST(1 - s.discount / s.subtotal, 0) ELSE 1 END`;

/**
 * What those units cost.
 *
 * Prefers the cost snapshotted on the line at sale time and falls back to the
 * product's current cost. `NULLIF(..., 0)` is what triggers the fallback:
 * lines written before cost-snapshotting existed carry 0 rather than null,
 * which is exactly what `Number(it.unitCost) || Number(product.costPrice)`
 * meant in the JS this replaced.
 */
const LINE_COST = Prisma.sql`${SOLD_QTY} * COALESCE(NULLIF(si."unitCost", 0), p."costPrice")`;

/**
 * Sales that count towards the books.
 *
 * Only HELD is excluded: a held cart is a parked basket, not a sale. Returned
 * and part-returned sales stay IN, because the money that wasn't handed back
 * is still revenue -- netting happens via `refundedTotal` (sale level) and
 * `returnedQty` (line level), not by discarding the whole sale. Excluding them
 * here is what made a 10,000 sale with one 200 item returned count as zero.
 */
const BOOKED: Prisma.EnumSaleStatusFilter = { notIn: [SaleStatus.HELD] };

/** Revenue actually kept: what was rung up, less what was handed back. */
const bookedRevenue = (agg: {
  _sum: { total: Prisma.Decimal | null; refundedTotal: Prisma.Decimal | null };
}) => round2(Number(agg._sum.total ?? 0) - Number(agg._sum.refundedTotal ?? 0));

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  /**
   * The zone this business's days are cut on.
   *
   * One indexed primary-key lookup per report. Worth not caching: a shop that
   * corrects its zone should see the next report land on the right days, and
   * this read is nothing beside the aggregation it precedes. Falls back to
   * Nepal rather than to UTC if the row has somehow gone -- UTC is the wrong
   * answer for every business on the system, and a report cut on the wrong
   * day is worse than one that errors.
   */
  private async timezone(businessId: string): Promise<string> {
    const b = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { timezone: true },
    });
    return b?.timezone || DEFAULT_TIMEZONE;
  }

  /**
   * The `WHERE` shared by every sale rollup, as SQL.
   *
   * Kept next to the Prisma `saleWhere` it mirrors so the two can be read
   * against each other -- a rollup that filtered differently from the totals
   * it sits beside would be the hardest kind of bug to spot on a chart.
   */
  /**
   * The instants a report covers. Calendar days (`fromDay` / `toDay`) are
   * cut on the shop's own clock and win over raw `from` / `to` instants, so
   * the range and the per-day buckets inside it agree on where a day starts.
   */
  async resolveRange(
    businessId: string,
    q: { from?: string; to?: string; fromDay?: string; toDay?: string; storeId?: string },
  ): Promise<{ from?: string; to?: string; storeId?: string }> {
    if (!q.fromDay && !q.toDay) return { from: q.from, to: q.to, storeId: q.storeId };
    const tz = await this.timezone(businessId);
    return {
      storeId: q.storeId,
      from: q.fromDay ? startOfDayKey(tz, q.fromDay).toISOString() : q.from,
      // The last millisecond of `toDay`: the next local midnight, less one.
      to: q.toDay ? new Date(startOfDayKey(tz, addDays(q.toDay, 1)).getTime() - 1).toISOString() : q.to,
    };
  }

  private saleFilterSql(
    businessId: string,
    opts: { storeId?: string; from?: string; to?: string },
    alias = 's',
  ) {
    const col = (name: string) => Prisma.raw(`"${alias}"."${name}"`);
    return Prisma.sql`
      ${col('businessId')} = ${businessId}
      AND ${col('status')} <> ${SaleStatus.HELD}::"SaleStatus"
      ${opts.storeId ? Prisma.sql`AND ${col('storeId')} = ${opts.storeId}` : Prisma.empty}
      ${opts.from ? Prisma.sql`AND ${col('createdAt')} >= ${utcBound(new Date(opts.from))}` : Prisma.empty}
      ${opts.to ? Prisma.sql`AND ${col('createdAt')} <= ${utcBound(new Date(opts.to))}` : Prisma.empty}
    `;
  }

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
    const tz = await this.timezone(businessId);
    // Local midnight, not the server's. On a US-hosted box serving Kathmandu
    // these are 5h45m apart, which is the whole early trade of the day.
    const startOfToday = startOfDay(tz);

    const saleWhere = {
      businessId,
      ...(storeId ? { storeId } : {}),
    };

    // Overall sales = all-time completed transactions (excludes held carts
    // and returned sales, which are not revenue).
    const completedWhere = {
      ...saleWhere,
      status: BOOKED,
    };

    const [sales, lowStock, expiring, inventoryValue, topProducts, slowProducts] =
      await Promise.all([
        this.prisma.sale.aggregate({
          where: completedWhere,
          _sum: { total: true, refundedTotal: true },
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

    // Charts and the credit position below are financial, so owner/manager
    // only. Credit is here rather than buried in Analytics because what is
    // owed is money already out the door -- for a shop running udhaaro it is
    // usually a more pressing number than margin.
    const [salesTrend, hourlyToday, credit] = includeFinancials
      ? await Promise.all([
          this.salesTrend(businessId, storeId, 14, tz),
          this.hourlyToday(businessId, storeId, startOfToday, tz),
          this.creditAgeing(businessId, { storeId }),
        ])
      : [undefined, undefined, undefined];

    return {
      totalSalesCount: sales._count,
      lowStockCount: lowStock.length,
      expiringSoonCount: expiring.length,
      topProducts,
      slowProducts,
      // Owner-only financial figures + charts.
      ...(includeFinancials
        ? {
            totalSalesTotal: bookedRevenue(sales),
            inventoryValue,
            salesTrend,
            hourlyToday,
            creditOutstanding: credit?.total ?? 0,
            creditOverdue: credit?.overdue ?? 0,
            creditCustomersOwing: credit?.customersOwing ?? 0,
          }
        : {}),
    };
  }

  /**
   * Outstanding customer credit (udhaaro), aged.
   *
   * The money already out the door. `Customer.creditBalance` is the
   * authoritative figure -- `payCredit` decrements it in one guarded
   * statement and attributes the payment to no particular sale -- so this
   * cannot simply sum what each invoice still shows unpaid: after a payment
   * the invoices would add up to more than the customer actually owes.
   *
   * Instead the balance is *allocated* across that customer's credit sales
   * newest-first, which is the same thing as assuming payments settled the
   * oldest debt first (FIFO, how a shopkeeper actually runs a khata). What is
   * left unsettled is therefore the most recent sales, and each allocated
   * slice is aged by the date of the sale it landed on.
   *
   * Arithmetic is in integer paisa throughout. Allocating in floats lets the
   * buckets drift a cent or two away from the balance they were carved from,
   * and the one property this report must have is that its parts add up to
   * `SELECT sum("creditBalance")`.
   *
   * A balance bigger than the credit sales can explain -- an opening balance,
   * a manual adjustment -- has no sale to age against and is reported
   * separately as `unattributed` rather than being quietly dropped or parked
   * in an arbitrary bucket.
   */
  async creditAgeing(
    businessId: string,
    opts: { storeId?: string; asOf?: Date } = {},
  ) {
    const now = opts.asOf ?? new Date();
    const creditSale = {
      status: BOOKED,
      paymentMethod: { in: [PaymentMethod.CREDIT, PaymentMethod.MIXED] },
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
    };

    const customers = await this.prisma.customer.findMany({
      where: {
        businessId,
        creditBalance: { gt: 0 },
        // Same rule as CreditService.receivables: a store filter narrows
        // *which* customers are listed, never what they owe. The balance is
        // one number per customer for the whole business, so a branch's share
        // of it does not exist to be reported.
        ...(opts.storeId ? { sales: { some: creditSale } } : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        creditBalance: true,
        sales: {
          where: creditSale,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            receiptNo: true,
            createdAt: true,
            total: true,
            amountPaid: true,
          },
        },
      },
    });

    const paisa = (d: Prisma.Decimal | number) => Math.round(Number(d) * 100);
    const rupees = (p: number) => round2(p / 100);
    const DAY = 24 * 60 * 60 * 1000;

    let current = 0; // 0-30 days
    let days30 = 0; // 31-60 days
    let days60Plus = 0; // over 60 days
    let unattributed = 0;

    const debtors = customers.map((c) => {
      let remaining = paisa(c.creditBalance);
      const own = { current: 0, days30: 0, days60Plus: 0 };
      let oldestUnpaidAt: Date | null = null;

      // Newest first: the tail of the debt is what survives FIFO payments.
      for (const sale of c.sales) {
        if (remaining <= 0) break;
        // What this sale still has on the khata. A return that cancels credit
        // raises amountPaid by the amount cancelled, so `total - amountPaid`
        // already nets it. refundedTotal carries that same amount too, and
        // subtracting it as well counted every such return twice -- the sale
        // looked short by the return and the difference was reported as
        // `unattributed`. Same rule as PaymentsService.customerStatement.
        const outstanding = paisa(sale.total) - paisa(sale.amountPaid);
        if (outstanding <= 0) continue;

        const allocated = Math.min(remaining, outstanding);
        remaining -= allocated;

        const age = Math.floor((now.getTime() - sale.createdAt.getTime()) / DAY);
        if (age <= 30) own.current += allocated;
        else if (age <= 60) own.days30 += allocated;
        else own.days60Plus += allocated;

        // Walking newest-first, the last sale we touch is the oldest one
        // still carrying money.
        oldestUnpaidAt = sale.createdAt;
      }

      current += own.current;
      days30 += own.days30;
      days60Plus += own.days60Plus;
      unattributed += remaining;

      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        balance: rupees(paisa(c.creditBalance)),
        current: rupees(own.current),
        days30: rupees(own.days30),
        days60Plus: rupees(own.days60Plus),
        unattributed: rupees(remaining),
        oldestUnpaidAt,
        oldestUnpaidDays: oldestUnpaidAt
          ? Math.floor((now.getTime() - oldestUnpaidAt.getTime()) / DAY)
          : null,
      };
    });

    const total = current + days30 + days60Plus + unattributed;

    return {
      total: rupees(total),
      // Anything past 30 days. This is the number worth chasing.
      overdue: rupees(days30 + days60Plus),
      buckets: {
        current: rupees(current),
        days30: rupees(days30),
        days60Plus: rupees(days60Plus),
      },
      unattributed: rupees(unattributed),
      customersOwing: customers.length,
      /** True when the figures are business-wide despite a store filter. */
      balancesAreBusinessWide: !!opts.storeId,
      topDebtors: [...debtors]
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 10),
    };
  }

  /** Sales totals over a date range, with a per-day breakdown. */
  async salesSummary(
    businessId: string,
    opts: { from?: string; to?: string; storeId?: string },
  ) {
    const tz = await this.timezone(businessId);

    // One GROUP BY rather than every sale in the range pulled into memory and
    // reduced. The totals are then the sum of the buckets, so the header
    // figure and the chart under it cannot disagree.
    const rows = await this.prisma.$queryRaw<
      { date: DayKey; total: Prisma.Decimal | null; count: bigint }[]
    >`
      SELECT ${localDay(Prisma.sql`s."createdAt"`, tz)} AS date,
             SUM(s.total - s."refundedTotal") AS total,
             COUNT(*)                         AS count
      FROM "Sale" s
      WHERE ${this.saleFilterSql(businessId, opts)}
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const byDay = rows.map((r) => ({
      date: r.date,
      total: round2(num(r.total)),
      count: Number(r.count),
    }));

    return {
      count: byDay.reduce((s, d) => s + d.count, 0),
      revenue: round2(byDay.reduce((s, d) => s + d.total, 0)),
      byDay,
    };
  }

  /**
   * Full analytics for the Analytics page: totals (gross sales, net revenue,
   * cost, profit, margin), plus per-product, per-day, per-category, per-hour,
   * per-payment-method and per-cashier rollups.
   *
   * Every rollup here is a `GROUP BY`. This function used to load every `Sale`
   * *and every `SaleItem`* in the range -- with a nested `product.categories`
   * join on each item -- and reduce them in JS, so "All time" meant the entire
   * trading history in the API process's heap at once. The rollups were all
   * plain aggregates, so they belong in the database; and with them there,
   * there is nothing left to cap. "All time" is a scan now, not a download.
   *
   * Days and hours are cut on the business's own time zone, so a shop in
   * Kathmandu sees its own trading day rather than the server's UTC one.
   *
   * Profit prefers the cost snapshotted on each line at sale time and falls
   * back to the product's current cost for sales recorded before snapshotting
   * existed. Quantities are net of returns. Revenue here is net of tax and
   * of line and bill discounts (see LINE_REVENUE); "gross sales" is what
   * customers paid, tax included.
   */
  async analytics(
    businessId: string,
    opts: { from?: string; to?: string; storeId?: string },
  ) {
    const { from, to } = opts;
    const tz = await this.timezone(businessId);
    const saleWhere: Prisma.SaleWhereInput = {
      businessId,
      ...(opts.storeId ? { storeId: opts.storeId } : {}),
      status: BOOKED,
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };
    const filter = this.saleFilterSql(businessId, opts);
    const saleDay = localDay(Prisma.sql`s."createdAt"`, tz);
    const saleHour = localHour(Prisma.sql`s."createdAt"`, tz);

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

    const [
      agg,
      byPaymentRaw,
      productRows,
      dayRows,
      dayUnitRows,
      categoryRows,
      hourRows,
      hourUnitRows,
      staffSaleRows,
      shiftRows,
      stockCostRows,
      prev,
    ] = await Promise.all([
      this.prisma.sale.aggregate({
        where: saleWhere,
        _sum: { total: true, refundedTotal: true },
        _count: true,
      }),
      this.prisma.sale.groupBy({
        by: ['paymentMethod'],
        where: saleWhere,
        _sum: { total: true, refundedTotal: true },
        _count: true,
      }),

      // Per product. The name comes from the catalog, not from
      // `SaleItem.name`, which is the snapshot taken at sale time -- otherwise
      // a renamed product reads one way here and another on the dashboard.
      this.prisma.$queryRaw<
        {
          productId: string;
          name: string;
          quantitySold: Prisma.Decimal | null;
          revenue: Prisma.Decimal | null;
          cost: Prisma.Decimal | null;
        }[]
      >`
        SELECT si."productId"  AS "productId",
               p.name          AS name,
               SUM(${SOLD_QTY})     AS "quantitySold",
               SUM(${LINE_REVENUE}) AS revenue,
               SUM(${LINE_COST})    AS cost
        FROM "SaleItem" si
        JOIN "Sale"    s ON s.id = si."saleId"
        JOIN "Product" p ON p.id = si."productId"
        WHERE ${filter} AND ${SOLD_QTY} > 0
        GROUP BY si."productId", p.name
      `,

      // Per day: revenue and order count off the sales themselves...
      this.prisma.$queryRaw<
        { date: DayKey; total: Prisma.Decimal | null; count: bigint }[]
      >`
        SELECT ${saleDay} AS date,
               SUM(s.total - s."refundedTotal") AS total,
               COUNT(*)                         AS count
        FROM "Sale" s
        WHERE ${filter}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      // ...and units off the lines. Two rollups rather than one join so the
      // order count stays a count of sales: joining the lines in first would
      // multiply each sale by the number of items on it.
      this.prisma.$queryRaw<{ date: DayKey; units: Prisma.Decimal | null }[]>`
        SELECT ${saleDay} AS date, SUM(${SOLD_QTY}) AS units
        FROM "SaleItem" si
        JOIN "Sale" s ON s.id = si."saleId"
        WHERE ${filter}
        GROUP BY 1
      `,

      // Per category, attributed to the product's first category. "First" was
      // whatever Prisma's join happened to return; it is pinned to the
      // earliest-created category here so the same sale lands in the same
      // slice on every run.
      this.prisma.$queryRaw<
        {
          category: string;
          revenue: Prisma.Decimal | null;
          units: Prisma.Decimal | null;
        }[]
      >`
        SELECT COALESCE(c.name, 'Uncategorized') AS category,
               SUM(${LINE_REVENUE}) AS revenue,
               SUM(${SOLD_QTY})     AS units
        FROM "SaleItem" si
        JOIN "Sale" s ON s.id = si."saleId"
        LEFT JOIN LATERAL (
          SELECT cat.name
          FROM "_ProductCategories" pc
          JOIN "Category" cat ON cat.id = pc."A"
          WHERE pc."B" = si."productId"
          ORDER BY cat.id ASC
          LIMIT 1
        ) c ON TRUE
        WHERE ${filter} AND ${SOLD_QTY} > 0
        GROUP BY 1
      `,

      // Per hour of the local day, across the whole range.
      this.prisma.$queryRaw<
        { hour: number; total: Prisma.Decimal | null; count: bigint }[]
      >`
        SELECT ${saleHour} AS hour,
               SUM(s.total - s."refundedTotal") AS total,
               COUNT(*)                         AS count
        FROM "Sale" s
        WHERE ${filter}
        GROUP BY 1
      `,
      this.prisma.$queryRaw<{ hour: number; units: Prisma.Decimal | null }[]>`
        SELECT ${saleHour} AS hour, SUM(${SOLD_QTY}) AS units
        FROM "SaleItem" si
        JOIN "Sale" s ON s.id = si."saleId"
        WHERE ${filter}
        GROUP BY 1
      `,

      // Per cashier. Sales carry `userId`, so who rang what has always been on
      // disk -- nothing read it. Sales from before staff attribution existed
      // have a null `userId` and are grouped under it rather than dropped, so
      // these rows still sum to the period's net revenue.
      this.prisma.$queryRaw<
        {
          userId: string | null;
          name: string | null;
          revenue: Prisma.Decimal | null;
          transactions: bigint;
        }[]
      >`
        SELECT s."userId" AS "userId",
               u.name     AS name,
               SUM(s.total - s."refundedTotal") AS revenue,
               COUNT(*)                         AS transactions
        FROM "Sale" s
        LEFT JOIN "User" u ON u.id = s."userId"
        WHERE ${filter}
        GROUP BY 1, 2
      `,

      // Drawer variance per cashier, over the shifts that *closed* in the
      // window -- a shift's variance only exists once it is counted, so
      // closedAt is the date that puts it in a period, not openedAt.
      //
      // Attributed to whoever opened the till, which is what `Shift.userId`
      // is. An owner or manager can join a cashier's open shift and sell from
      // the same drawer, and their sales then count towards that drawer's
      // variance. That is the right answer -- one drawer, one count, one
      // person responsible for it -- but it does mean a variance row can
      // include takings the named cashier did not ring up. `byStaff.revenue`
      // is unaffected: that comes from `Sale.userId`, which always records
      // who actually made the sale.
      this.prisma.$queryRaw<
        {
          userId: string;
          name: string;
          shifts: bigint;
          totalVariance: Prisma.Decimal | null;
          meanVariance: Prisma.Decimal | null;
          worstVariance: Prisma.Decimal | null;
        }[]
      >`
        SELECT sh."userId" AS "userId",
               u.name      AS name,
               COUNT(*)         AS shifts,
               SUM(sh.variance) AS "totalVariance",
               AVG(sh.variance) AS "meanVariance",
               MIN(sh.variance) AS "worstVariance"
        FROM "Shift" sh
        JOIN "User" u ON u.id = sh."userId"
        WHERE sh."businessId" = ${businessId}
          AND sh."closedAt" IS NOT NULL
          AND sh.variance IS NOT NULL
          ${opts.storeId ? Prisma.sql`AND sh."storeId" = ${opts.storeId}` : Prisma.empty}
          ${from ? Prisma.sql`AND sh."closedAt" >= ${utcBound(new Date(from))}` : Prisma.empty}
          ${to ? Prisma.sql`AND sh."closedAt" <= ${utcBound(new Date(to))}` : Prisma.empty}
        GROUP BY 1, 2
      `,

      // Closing inventory cost per product, for GMROI below.
      this.prisma.$queryRaw<
        { productId: string; value: Prisma.Decimal | null }[]
      >`
        SELECT st."productId" AS "productId",
               SUM(st.quantity * p."costPrice") AS value
        FROM "StockItem" st
        JOIN "Product" p ON p.id = st."productId"
        WHERE st."businessId" = ${businessId}
          ${opts.storeId ? Prisma.sql`AND st."storeId" = ${opts.storeId}` : Prisma.empty}
        GROUP BY 1
      `,

      prevWindow
        ? (async () => {
            const prevOpts = {
              storeId: opts.storeId,
              from: prevWindow.from,
              to: prevWindow.to,
            };
            const prevFilter = this.saleFilterSql(businessId, prevOpts);
            const [prevAgg, prevLines] = await Promise.all([
              this.prisma.sale.aggregate({
                where: {
                  businessId,
                  ...(opts.storeId ? { storeId: opts.storeId } : {}),
                  status: BOOKED,
                  createdAt: {
                    gte: new Date(prevWindow.from),
                    lte: new Date(prevWindow.to),
                  },
                },
                _sum: { total: true, refundedTotal: true },
                _count: true,
              }),
              // Same `SOLD_QTY > 0` filter as the selected window. Without it
              // the comparison counted fully-returned lines on one side and
              // not the other, so the % change was measured against a figure
              // the current period never reported.
              this.prisma.$queryRaw<
                { revenue: Prisma.Decimal | null; cost: Prisma.Decimal | null }[]
              >`
                SELECT SUM(${LINE_REVENUE}) AS revenue,
                       SUM(${LINE_COST})    AS cost
                FROM "SaleItem" si
                JOIN "Sale"    s ON s.id = si."saleId"
                JOIN "Product" p ON p.id = si."productId"
                WHERE ${prevFilter} AND ${SOLD_QTY} > 0
              `,
            ]);
            const prevRevenue = num(prevLines[0]?.revenue);
            const prevCost = num(prevLines[0]?.cost);
            return {
              revenue: bookedRevenue(prevAgg),
              orders: prevAgg._count,
              netRevenue: round2(prevRevenue),
              profit: round2(prevRevenue - prevCost),
            };
          })()
        : Promise.resolve(null),
    ]);

    const stockCost = new Map(
      stockCostRows.map((r) => [r.productId, num(r.value)]),
    );

    const byProduct = productRows
      .map((r) => {
        const revenue = round2(num(r.revenue));
        const cost = round2(num(r.cost));
        const profit = round2(revenue - cost);
        // GMROI: gross profit per rupee tied up in the product. Margin says
        // what is profitable; this says what earns its shelf space -- a
        // 12%-margin item that sells daily beats a 40%-margin one that moves
        // twice a month. Simplification: the divisor is *closing* inventory
        // cost, not the average held over the range, because stock levels
        // aren't historised. It is a fair proxy for a shop that reorders to a
        // level, and overstates GMROI for anything run down to nothing during
        // the period. Null, not Infinity, when nothing is left on the shelf:
        // a return on no investment is not a number worth ranking on.
        const inventoryCost = stockCost.get(r.productId) ?? 0;
        return {
          productId: r.productId,
          name: r.name,
          quantitySold: num(r.quantitySold),
          revenue,
          cost,
          profit,
          inventoryCost: round2(inventoryCost),
          gmroi: inventoryCost > 0 ? round2(profit / inventoryCost) : null,
        };
      })
      .sort((a, b) => b.profit - a.profit);

    const netRevenue = round2(byProduct.reduce((s, p) => s + p.revenue, 0));
    const cost = round2(byProduct.reduce((s, p) => s + p.cost, 0));
    const profit = round2(netRevenue - cost);

    // By day: revenue + order count (from sales) and units (from items)
    const dayUnits = new Map(dayUnitRows.map((r) => [r.date, num(r.units)]));
    const byDay = dayRows.map((r) => ({
      date: r.date,
      total: round2(num(r.total)),
      count: Number(r.count),
      units: dayUnits.get(r.date) ?? 0,
    }));

    const catTotal =
      categoryRows.reduce((s, c) => s + num(c.revenue), 0) || 1;
    const byCategory = categoryRows
      .map((c) => ({
        category: c.category,
        revenue: round2(num(c.revenue)),
        units: num(c.units),
        share: round2((num(c.revenue) / catTotal) * 100),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Hour-of-day buckets across the whole range, zero-filled to 24.
    const hourUnits = new Map(hourUnitRows.map((r) => [r.hour, num(r.units)]));
    const hourTotals = new Map(hourRows.map((r) => [r.hour, r]));
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      total: round2(num(hourTotals.get(hour)?.total)),
      count: Number(hourTotals.get(hour)?.count ?? 0),
      units: hourUnits.get(hour) ?? 0,
    }));

    // Payment methods with % share
    const payTotal = byPaymentRaw.reduce((s, p) => s + bookedRevenue(p), 0) || 1;
    const byPaymentMethod = byPaymentRaw
      .map((p) => ({
        method: p.paymentMethod,
        total: bookedRevenue(p),
        count: p._count,
        share: round2((bookedRevenue(p) / payTotal) * 100),
      }))
      .sort((a, b) => b.total - a.total);

    // Per cashier: what they sold, and how straight their drawer came out.
    // The two halves are joined on the user rather than queried together
    // because a cashier can sell without ever closing a shift, and an owner
    // can close one having rung up nothing.
    const variance = new Map(shiftRows.map((r) => [r.userId, r]));
    const staffIds = new Set<string>([
      ...staffSaleRows.map((r) => r.userId).filter((id): id is string => !!id),
      ...shiftRows.map((r) => r.userId),
    ]);
    const salesByUser = new Map(staffSaleRows.map((r) => [r.userId, r]));
    const byStaff = [...staffIds]
      .map((userId) => {
        const sold = salesByUser.get(userId);
        const v = variance.get(userId);
        const revenue = round2(num(sold?.revenue));
        const transactions = Number(sold?.transactions ?? 0);
        return {
          userId,
          name: sold?.name ?? v?.name ?? 'Unknown user',
          revenue,
          transactions,
          averageBasket: transactions > 0 ? round2(revenue / transactions) : 0,
          shifts: Number(v?.shifts ?? 0),
          // Negative is short in the drawer, which is the direction that
          // matters; `worstVariance` is the single worst count, not the net,
          // because a short day cancelled out by a long one is still two
          // days that didn't reconcile.
          totalVariance: v ? round2(num(v.totalVariance)) : null,
          meanVariance: v ? round2(num(v.meanVariance)) : null,
          worstVariance: v ? round2(num(v.worstVariance)) : null,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    // Sales with no cashier on them (recorded before staff attribution, or by
    // a deleted user) are reported separately so `byStaff` can be read as
    // "per cashier" while the two together still reconcile: every
    // `byStaff.revenue` plus `unattributed.revenue` equals
    // `totals.grossSales`, both being SUM(total - refundedTotal). They do not
    // sum to `totals.netRevenue`, which is a line-level figure net of tax.
    const unattributedSales = staffSaleRows.find((r) => r.userId === null);

    // Inventory performance (across the selected period)
    const [inventoryValue, onHand, movements, needs, leaks, byStore] = await Promise.all([
      this.inventoryValue(businessId, opts.storeId),
      this.prisma.stockItem.aggregate({
        where: { businessId, ...(opts.storeId ? { storeId: opts.storeId } : {}) },
        _sum: { quantity: true },
      }),
      this.stockMovementDaily(businessId, opts.storeId, tz, from, to),
      this.needsAttention(businessId, opts.storeId),
      this.moneyLeaks(businessId, opts),
      opts.storeId ? Promise.resolve([]) : this.byStore(businessId, opts),
    ]);
    const totalUnits = byProduct.reduce((s, p) => s + p.quantitySold, 0);
    const stockTurnover =
      inventoryValue > 0 ? round2(cost / inventoryValue) : 0;
    // Units sold as a share of units that were available to sell: sold over
    // (sold + still on hand). This used to divide units by rupees/10 --
    // inventory *value* standing in for a unit count -- so the figure moved
    // with prices rather than with sales. Negative stock (oversold) counts as
    // none on hand.
    const onHandUnits = Math.max(Number(onHand._sum.quantity ?? 0), 0);
    const sellThrough =
      totalUnits + onHandUnits > 0
        ? round2((totalUnits / (totalUnits + onHandUnits)) * 100)
        : 0;

    // Days of stock left at this period's selling pace: stock at cost over
    // the cost of goods sold per day. Unlike turnover, it doesn't change with
    // the length of the range picked. "All time" measures its pace from the
    // first day with a sale. Null when nothing sold -- no pace to measure.
    const firstDay = byDay.find((d) => d.count > 0)?.date;
    const rangeDays =
      from && to
        ? Math.max(Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000), 1)
        : firstDay
          ? Math.max(Math.ceil((Date.now() - startOfDayKey(tz, firstDay).getTime()) / 86_400_000), 1)
          : 0;
    const dailyCost = rangeDays > 0 ? cost / rangeDays : 0;
    const daysOfCover = dailyCost > 0 ? Math.round(inventoryValue / dailyCost) : null;

    // What the shop actually kept: gross profit, less till expenses and the
    // cost of stock written off. Discounts and refunds are already out of
    // revenue (and so of gross profit), so they aren't taken off twice.
    const netProfit = round2(profit - leaks.expenses.total - leaks.writeOffs.value);

    return {
      timezone: tz,
      totals: {
        transactions: agg._count,
        grossSales: bookedRevenue(agg),
        netRevenue,
        cost,
        profit,
        margin: netRevenue > 0 ? round2((profit / netRevenue) * 100) : 0,
        units: totalUnits,
        // Sales including tax less net sales: the tax collected on them.
        tax: round2(bookedRevenue(agg) - netRevenue),
        netProfit,
      },
      money: leaks,
      byStore,
      comparison: prev
        ? {
            revenue: prev.revenue,
            orders: prev.orders,
            netRevenue: prev.netRevenue,
            profit: prev.profit,
          }
        : null,
      byProduct,
      byDay,
      byCategory,
      byPaymentMethod,
      byStaff,
      unattributed: unattributedSales
        ? {
            revenue: round2(num(unattributedSales.revenue)),
            transactions: Number(unattributedSales.transactions),
          }
        : null,
      hourly: hours,
      inventory: {
        value: inventoryValue,
        stockTurnover,
        daysOfCover,
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
          status: BOOKED,
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
        sale: { select: { taxInclusive: true, subtotal: true, discount: true } },
      },
    });

    const byRate = new Map<number, { taxableAmount: number; tax: number }>();
    let taxableAmount = 0;
    let taxCollected = 0;
    let grossSales = 0;

    for (const it of items) {
      const soldQty = Number(it.quantity) - Number(it.returnedQty);
      if (soldQty <= 0) continue;
      const rate = Number(it.taxRate);
      // Price less the per-unit discount, scaled to the non-returned
      // quantity. Before tax, unless the sale was priced tax-inclusive.
      const perUnit =
        Number(it.unitPrice) - Number(it.discount) / (Number(it.quantity) || 1);
      const { net: lineNet, tax: lineTax } = splitTax(
        perUnit * soldQty,
        rate,
        it.sale.taxInclusive,
      );
      taxableAmount += lineNet;
      taxCollected += lineTax;
      // A bill discount comes off after tax is worked out, so it changes
      // neither figure above -- but the customer paid that much less.
      // Without it, this report's gross sales ran above the Analytics
      // revenue on the same page by every bill discount given.
      const subtotal = Number(it.sale.subtotal);
      const billShare = subtotal > 0 ? Number(it.sale.discount) / subtotal : 0;
      grossSales += lineNet + lineTax - lineNet * billShare;
      if (rate > 0) {
        const cur = byRate.get(rate) ?? { taxableAmount: 0, tax: 0 };
        cur.taxableAmount += lineNet;
        cur.tax += lineTax;
        byRate.set(rate, cur);
      }
    }

    const purchases = await this.inputTax(businessId, opts);
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
      purchases,
      // What is owed to the tax office for the period: VAT collected on
      // sales less the VAT paid to suppliers. Negative is a credit carried.
      netTax: round2(round2(taxCollected) - purchases.taxPaid),
    };
  }

  /**
   * Input VAT: what suppliers charged on goods received in the period, by
   * rate, less anything sent back to them. Dated by when the goods arrived,
   * the date on the supplier's invoice; a draft never received has no VAT.
   */
  private async inputTax(
    businessId: string,
    opts: { from?: string; to?: string; storeId?: string },
  ) {
    const lines = await this.prisma.purchaseItem.findMany({
      where: {
        taxRate: { gt: 0 },
        purchase: {
          businessId,
          status: PurchaseStatus.RECEIVED,
          ...(opts.storeId ? { storeId: opts.storeId } : {}),
          ...(opts.from || opts.to
            ? {
                receivedAt: {
                  ...(opts.from ? { gte: new Date(opts.from) } : {}),
                  ...(opts.to ? { lte: new Date(opts.to) } : {}),
                },
              }
            : {}),
        },
      },
      select: { quantity: true, returnedQty: true, costPrice: true, taxRate: true },
    });
    const byRate = new Map<number, { taxableAmount: number; tax: number }>();
    for (const l of lines) {
      const kept = Number(l.quantity) - Number(l.returnedQty);
      if (kept <= 0) continue;
      const rate = Number(l.taxRate);
      const net = kept * Number(l.costPrice);
      const cur = byRate.get(rate) ?? { taxableAmount: 0, tax: 0 };
      cur.taxableAmount += net;
      cur.tax += (net * rate) / 100;
      byRate.set(rate, cur);
    }
    const rows = [...byRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rate, v]) => ({ rate, taxableAmount: round2(v.taxableAmount), tax: round2(v.tax) }));
    return {
      taxableAmount: round2(rows.reduce((n, r) => n + r.taxableAmount, 0)),
      taxPaid: round2(rows.reduce((n, r) => n + r.tax, 0)),
      byRate: rows,
    };
  }

  // ---- helpers ----

  private async inventoryValue(businessId: string, storeId?: string) {
    const items = await this.prisma.stockItem.findMany({
      where: { businessId, ...(storeId ? { storeId } : {}) },
      select: { quantity: true, product: { select: { costPrice: true } } },
    });
    const value = items.reduce(
      (sum, it) => sum + Number(it.quantity) * Number(it.product.costPrice),
      0,
    );
    return Math.round(value * 100) / 100;
  }

  /**
   * Best sellers by units. Grouped by product alone: `SaleItem.name` is the
   * name snapshotted at sale time, so grouping by it as well split a renamed
   * product into one row per name it has ever been sold under -- understating
   * each, taking two of the `take` slots, and handing the dashboard duplicate
   * React keys. Names come from the product itself so the list shows what the
   * catalog calls it today.
   */
  private async topProducts(businessId: string, storeId: string | undefined, take: number) {
    // Units kept, not units rung up: a held cart is not a sale, and a unit
    // brought back was not sold. The Prisma groupBy this replaced counted
    // both -- it had no status filter and summed raw `quantity` -- so a
    // parked cart or a big return could put a product at the top of the
    // dashboard. Same filter and same SOLD_QTY as every other rollup here.
    const grouped = await this.prisma.$queryRaw<
      { productId: string; sold: Prisma.Decimal }[]
    >`
      SELECT si."productId", SUM(${SOLD_QTY}) AS sold
      FROM "SaleItem" si
      JOIN "Sale" s ON s.id = si."saleId"
      WHERE ${this.saleFilterSql(businessId, { storeId })}
      GROUP BY si."productId"
      HAVING SUM(${SOLD_QTY}) > 0
      ORDER BY sold DESC
      LIMIT ${take}
    `;

    const names = new Map(
      (
        await this.prisma.product.findMany({
          where: { id: { in: grouped.map((g) => g.productId) } },
          select: { id: true, name: true },
        })
      ).map((p) => [p.id, p.name]),
    );

    return grouped.map((g) => ({
      productId: g.productId,
      // Products are soft-deleted and SaleItem.product is required, so the row
      // is always there; the fallback only guards against a blank name.
      name: names.get(g.productId) || 'Unknown product',
      quantitySold: Number(g.sold),
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
      // Units kept, the same rule as topProducts: the Prisma groupBy this
      // replaced had no status filter and summed raw `quantity`, so a parked
      // cart or a returned unit made a product look like it was moving.
      this.prisma.$queryRaw<{ productId: string; sold: Prisma.Decimal }[]>`
        SELECT si."productId", SUM(${SOLD_QTY}) AS sold
        FROM "SaleItem" si
        JOIN "Sale" s ON s.id = si."saleId"
        WHERE ${this.saleFilterSql(businessId, { storeId, from: since.toISOString() })}
        GROUP BY si."productId"
      `,
    ]);

    const soldMap = new Map(sold.map((s) => [s.productId, Math.max(0, Number(s.sold))]));
    return products
      .map((p) => ({
        productId: p.id,
        name: p.name,
        costPrice: Number(p.costPrice),
        quantitySold: soldMap.get(p.id) ?? 0,
        inStock: p.stockItems.reduce((s, si) => s + Number(si.quantity), 0),
      }))
      .sort((a, b) => a.quantitySold - b.quantitySold || b.inStock - a.inStock)
      .slice(0, take);
  }

  /**
   * Daily sales totals for the last `days` local days (continuous,
   * zero-filled). The window starts at local midnight `days - 1` days back,
   * so "last 14 days" means fourteen of the shop's own trading days.
   */
  private async salesTrend(
    businessId: string,
    storeId: string | undefined,
    days: number,
    tz: string,
  ) {
    const today = dayKey(tz, new Date());
    const firstDay = addDays(today, -(days - 1));
    const start = startOfDayKey(tz, firstDay);

    const rows = await this.prisma.$queryRaw<
      { date: DayKey; total: Prisma.Decimal | null; count: bigint }[]
    >`
      SELECT ${localDay(Prisma.sql`s."createdAt"`, tz)} AS date,
             SUM(s.total - s."refundedTotal") AS total,
             COUNT(*)                         AS count
      FROM "Sale" s
      WHERE ${this.saleFilterSql(businessId, { storeId })}
        AND s."createdAt" >= ${utcBound(start)}
      GROUP BY 1
    `;

    const byDay = new Map(
      rows.map((r) => [
        r.date,
        { total: round2(num(r.total)), count: Number(r.count) },
      ]),
    );
    return dayKeysBetween(firstDay, today).map((date) => ({
      date,
      ...(byDay.get(date) ?? { total: 0, count: 0 }),
    }));
  }

  /** Today's sales totals bucketed by local hour (0–23, zero-filled). */
  private async hourlyToday(
    businessId: string,
    storeId: string | undefined,
    startOfToday: Date,
    tz: string,
  ) {
    const rows = await this.prisma.$queryRaw<
      { hour: number; total: Prisma.Decimal | null; count: bigint }[]
    >`
      SELECT ${localHour(Prisma.sql`s."createdAt"`, tz)} AS hour,
             SUM(s.total - s."refundedTotal") AS total,
             COUNT(*)                         AS count
      FROM "Sale" s
      WHERE ${this.saleFilterSql(businessId, { storeId })}
        AND s."createdAt" >= ${utcBound(startOfToday)}
      GROUP BY 1
    `;

    const byHour = new Map(rows.map((r) => [r.hour, r]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      total: round2(num(byHour.get(hour)?.total)),
      count: Number(byHour.get(hour)?.count ?? 0),
    }));
  }

  /**
   * Daily stock-movement buckets (purchases in, sales out, adjustments net)
   * plus a running closing-stock index for the selected window.
   */
  /**
   * Where money goes between the shelf and the bank, for the period:
   *
   * - discounts given at the till, in total and by who gave them;
   * - refunds: cash handed back on returns (a return on a credit sale cancels
   *   the debt instead, so it isn't here), and units taken back;
   * - write-offs: stock taken off the shelf by hand as damaged, expired,
   *   stolen, missing at a count or otherwise -- valued at today's cost
   *   price, since a movement doesn't record what the unit cost;
   * - expenses paid out of the till (Cash in/out, reason Expense), and owner
   *   drawings, which are shown but aren't a cost.
   */
  private async moneyLeaks(businessId: string, opts: { storeId?: string; from?: string; to?: string }) {
    const filter = this.saleFilterSql(businessId, opts);
    const within = (col: Prisma.Sql) => Prisma.sql`
      ${opts.from ? Prisma.sql`AND ${col} >= ${utcBound(new Date(opts.from))}` : Prisma.empty}
      ${opts.to ? Prisma.sql`AND ${col} <= ${utcBound(new Date(opts.to))}` : Prisma.empty}`;
    const store = (col: Prisma.Sql) => (opts.storeId ? Prisma.sql`AND ${col} = ${opts.storeId}` : Prisma.empty);

    const [discountRows, refundRows, returnRows, lossRows, cashRows] = await Promise.all([
      // Line and bill discounts together, per person who rang the sale.
      this.prisma.$queryRaw<
        {
          userId: string | null;
          name: string | null;
          amount: Prisma.Decimal | null;
          discounted: bigint;
          sales: bigint;
          rung: Prisma.Decimal | null;
        }[]
      >`
        SELECT s."userId" AS "userId", u.name AS name,
               SUM(s.discount + COALESCE(l.d, 0))                          AS amount,
               COUNT(*) FILTER (WHERE s.discount > 0 OR COALESCE(l.d, 0) > 0) AS discounted,
               COUNT(*)                                                     AS sales,
               SUM(s.total)                                                 AS rung
        FROM "Sale" s
        LEFT JOIN LATERAL (
          SELECT SUM(si.discount) AS d FROM "SaleItem" si WHERE si."saleId" = s.id
        ) l ON TRUE
        LEFT JOIN "User" u ON u.id = s."userId"
        WHERE ${filter}
        GROUP BY 1, 2
      `,
      this.prisma.$queryRaw<{ amount: Prisma.Decimal | null; count: bigint }[]>`
        SELECT SUM(pm.amount) AS amount, COUNT(*) AS count
        FROM "Payment" pm
        WHERE pm."businessId" = ${businessId}
          AND pm.type = ${PaymentType.REFUND}::"PaymentType"
          ${store(Prisma.sql`pm."storeId"`)}
          ${within(Prisma.sql`pm."createdAt"`)}
      `,
      this.prisma.$queryRaw<{ units: Prisma.Decimal | null; sales: bigint }[]>`
        SELECT SUM(m.quantity) AS units, COUNT(DISTINCT m.reference) AS sales
        FROM "StockMovement" m
        WHERE m."businessId" = ${businessId}
          AND m.type = ${StockMovementType.RETURN_IN}::"StockMovementType"
          ${store(Prisma.sql`m."storeId"`)}
          ${within(Prisma.sql`m."createdAt"`)}
      `,
      this.prisma.$queryRaw<{ reason: AdjustmentReason | null; units: Prisma.Decimal | null; value: Prisma.Decimal | null }[]>`
        SELECT m.reason AS reason,
               SUM(-m.quantity)                 AS units,
               SUM(-m.quantity * p."costPrice") AS value
        FROM "StockMovement" m
        JOIN "Product" p ON p.id = m."productId"
        WHERE m."businessId" = ${businessId}
          AND m.type = ${StockMovementType.ADJUSTMENT}::"StockMovementType"
          AND m.quantity < 0
          ${store(Prisma.sql`m."storeId"`)}
          ${within(Prisma.sql`m."createdAt"`)}
        GROUP BY 1
      `,
      this.prisma.$queryRaw<{ reason: CashMovementReason; amount: Prisma.Decimal | null; count: bigint }[]>`
        SELECT cm.reason AS reason, SUM(cm.amount) AS amount, COUNT(*) AS count
        FROM "CashMovement" cm
        JOIN "Shift" sh ON sh.id = cm."shiftId"
        WHERE cm."businessId" = ${businessId}
          AND cm.type = ${CashMovementType.PAY_OUT}::"CashMovementType"
          AND cm.reason IN (
            ${CashMovementReason.EXPENSE}::"CashMovementReason",
            ${CashMovementReason.OWNER_DRAW}::"CashMovementReason"
          )
          ${store(Prisma.sql`sh."storeId"`)}
          ${within(Prisma.sql`cm."createdAt"`)}
        GROUP BY 1
      `,
    ]);

    const byStaff = discountRows
      .map((r) => {
        const amount = round2(num(r.amount));
        const rung = num(r.rung);
        return {
          userId: r.userId,
          name: r.name ?? (r.userId ? 'Unknown user' : 'Not recorded'),
          amount,
          discounted: Number(r.discounted),
          sales: Number(r.sales),
          // Share of what would have been charged without the discounts.
          pct: rung + amount > 0 ? round2((amount / (rung + amount)) * 100) : 0,
        };
      })
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const discountTotal = round2(byStaff.reduce((sum, r) => sum + r.amount, 0));
    const rungTotal = discountRows.reduce((sum, r) => sum + num(r.rung), 0);

    const writeOffs = lossRows
      .map((r) => ({ reason: r.reason ?? 'OTHER', units: round2(num(r.units)), value: round2(num(r.value)) }))
      .filter((r) => r.units > 0)
      .sort((a, b) => b.value - a.value);
    const cash = (reason: CashMovementReason) => cashRows.find((r) => r.reason === reason);
    const sales = discountRows.reduce((n, r) => n + Number(r.sales), 0);
    const returnedSales = Number(returnRows[0]?.sales ?? 0);

    return {
      discounts: {
        total: discountTotal,
        salesWithDiscount: byStaff.reduce((n, r) => n + r.discounted, 0),
        pct: rungTotal + discountTotal > 0 ? round2((discountTotal / (rungTotal + discountTotal)) * 100) : 0,
        byStaff,
      },
      refunds: {
        total: round2(num(refundRows[0]?.amount)),
        count: Number(refundRows[0]?.count ?? 0),
        unitsReturned: round2(num(returnRows[0]?.units)),
        // Returns processed in the period against sales made in it: a rough
        // return rate, fine for spotting a trend.
        returnRate: sales > 0 ? round2((returnedSales / sales) * 100) : 0,
      },
      writeOffs: {
        value: round2(writeOffs.reduce((sum, r) => sum + r.value, 0)),
        units: round2(writeOffs.reduce((sum, r) => sum + r.units, 0)),
        byReason: writeOffs,
      },
      expenses: {
        total: round2(num(cash(CashMovementReason.EXPENSE)?.amount)),
        count: Number(cash(CashMovementReason.EXPENSE)?.count ?? 0),
      },
      ownerDrawings: round2(num(cash(CashMovementReason.OWNER_DRAW)?.amount)),
    };
  }

  /**
   * Each branch side by side: sales, net sales, gross profit and orders.
   * Empty for a single-store shop -- there is nothing to compare.
   */
  private async byStore(businessId: string, opts: { from?: string; to?: string }) {
    const stores = await this.prisma.store.findMany({
      where: { businessId },
      select: { id: true, name: true, isActive: true },
    });
    if (stores.length < 2) return [];
    const filter = this.saleFilterSql(businessId, opts);
    const [saleRows, lineRows] = await Promise.all([
      this.prisma.$queryRaw<{ storeId: string; name: string; orders: bigint; sales: Prisma.Decimal | null }[]>`
        SELECT s."storeId" AS "storeId", st.name AS name,
               COUNT(*) AS orders, SUM(s.total - s."refundedTotal") AS sales
        FROM "Sale" s
        JOIN "Store" st ON st.id = s."storeId"
        WHERE ${filter}
        GROUP BY 1, 2
      `,
      this.prisma.$queryRaw<{ storeId: string; revenue: Prisma.Decimal | null; cost: Prisma.Decimal | null }[]>`
        SELECT s."storeId" AS "storeId", SUM(${LINE_REVENUE}) AS revenue, SUM(${LINE_COST}) AS cost
        FROM "SaleItem" si
        JOIN "Sale"    s ON s.id = si."saleId"
        JOIN "Product" p ON p.id = si."productId"
        WHERE ${filter} AND ${SOLD_QTY} > 0
        GROUP BY 1
      `,
    ]);
    const lines = new Map(lineRows.map((r) => [r.storeId, r]));
    const salesBy = new Map(saleRows.map((r) => [r.storeId, r]));
    const totalSales = saleRows.reduce((sum, r) => sum + num(r.sales), 0);
    // Every active branch, and any closed one that still sold in the period:
    // a branch with nothing rung up is the row most worth seeing.
    return stores
      .filter((st) => st.isActive || salesBy.has(st.id))
      .map((st) => ({ storeId: st.id, name: st.name, orders: 0n, sales: null, ...salesBy.get(st.id) }))
      .map((r) => {
        const l = lines.get(r.storeId);
        const netRevenue = round2(num(l?.revenue));
        const profit = round2(netRevenue - num(l?.cost));
        const orders = Number(r.orders);
        const sales = round2(num(r.sales));
        return {
          storeId: r.storeId,
          name: r.name,
          sales,
          netRevenue,
          profit,
          margin: netRevenue > 0 ? round2((profit / netRevenue) * 100) : 0,
          orders,
          averageBill: orders > 0 ? round2(sales / orders) : 0,
          share: totalSales > 0 ? round2((sales / totalSales) * 100) : 0,
        };
      })
      .sort((a, b) => b.sales - a.sales);
  }

  private async stockMovementDaily(
    businessId: string,
    storeId: string | undefined,
    tz: string,
    from?: string,
    to?: string,
  ) {
    const day = localDay(Prisma.sql`m."createdAt"`, tz);
    const rows = await this.prisma.$queryRaw<
      {
        date: DayKey;
        purchases: Prisma.Decimal | null;
        sales: Prisma.Decimal | null;
        adjustments: Prisma.Decimal | null;
        net: Prisma.Decimal | null;
      }[]
    >`
      SELECT ${day} AS date,
             SUM(m.quantity) FILTER (WHERE m.type = ${StockMovementType.PURCHASE}::"StockMovementType")  AS purchases,
             SUM(-m.quantity) FILTER (WHERE m.type = ${StockMovementType.SALE}::"StockMovementType")     AS sales,
             SUM(m.quantity) FILTER (
               WHERE m.type NOT IN (
                 ${StockMovementType.PURCHASE}::"StockMovementType",
                 ${StockMovementType.SALE}::"StockMovementType"
               )
             ) AS adjustments,
             SUM(m.quantity) AS net
      FROM "StockMovement" m
      WHERE m."businessId" = ${businessId}
        ${storeId ? Prisma.sql`AND m."storeId" = ${storeId}` : Prisma.empty}
        ${from ? Prisma.sql`AND m."createdAt" >= ${utcBound(new Date(from))}` : Prisma.empty}
        ${to ? Prisma.sql`AND m."createdAt" <= ${utcBound(new Date(to))}` : Prisma.empty}
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    // The closing index is a running total across the window, so it stays in
    // JS -- a window function could do it, but the rows are one per day and
    // the arithmetic is clearer here. It counts from zero at the start of the
    // range rather than from the stock on hand then, which is what made it an
    // index of movement rather than a stock level; unchanged, but worth
    // saying out loud now the rest of this is exact.
    let closing = 0;
    return rows.map((r) => {
      closing += num(r.net);
      return {
        date: r.date,
        purchases: round2(num(r.purchases)),
        sales: round2(num(r.sales)),
        adjustments: round2(num(r.adjustments)),
        closing: round2(closing),
      };
    });
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
