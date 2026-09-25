import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailStatus, Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { paginate } from '../common/dto/pagination.dto';
import { cronRuns, processStartedAt } from '../common/cron-status';
import { DAY_MS, graceDays, supportContact } from '../common/subscription';
import { utcBound } from '../common/sql-time';
import { QueryEmailLogDto } from './dto/platform.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** package.json's version, read once. Absent in odd deploy layouts: null. */
const APP_VERSION: string | null = (() => {
  try {
    return (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version?: string })
      .version ?? null;
  } catch {
    return null;
  }
})();

/**
 * Read-only views across the whole platform: growth, system health and the
 * email log. None of them reads a shop's own records, so unlike the
 * per-business views they aren't written to the admin log.
 */
@Injectable()
export class PlatformInsightsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private settings: SettingsService,
  ) {}

  /**
   * Is the platform growing, and who is slipping away?
   *
   * - signups per week for the last 12 weeks (UTC, Monday-start);
   * - active: a sale in the last 7 days;
   * - at risk: has sold before, but nothing in 14 days, and not suspended;
   * - subscription payments collected this month and last, per currency.
   */
  async growth(now = new Date()) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    const [weeks, active, atRisk, businesses, newThisMonth, paidThis, paidLast] = await Promise.all([
      this.prisma.$queryRaw<{ week: Date; count: number }[]>`
        SELECT date_trunc('week', "createdAt") AS week, COUNT(*)::int AS count
        FROM "Business"
        WHERE "createdAt" >= date_trunc('week', ${utcBound(now)}) - interval '11 weeks'
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(DISTINCT "businessId")::int AS count
        FROM "Sale"
        WHERE status <> 'HELD' AND "createdAt" >= ${utcBound(new Date(now.getTime() - 7 * DAY_MS))}
      `,
      this.prisma.$queryRaw<{ id: string; name: string; lastSaleAt: Date }[]>`
        SELECT b.id, b.name, MAX(s."createdAt") AS "lastSaleAt"
        FROM "Business" b
        JOIN "Sale" s ON s."businessId" = b.id AND s.status <> 'HELD'
        WHERE NOT b."isSuspended"
        GROUP BY b.id, b.name
        HAVING MAX(s."createdAt") < ${utcBound(new Date(now.getTime() - 14 * DAY_MS))}
        ORDER BY MAX(s."createdAt") ASC
      `,
      this.prisma.business.count(),
      this.prisma.business.count({ where: { createdAt: { gte: monthStart } } }),
      this.paymentsBetween(monthStart, now),
      this.paymentsBetween(lastMonthStart, monthStart),
    ]);

    // One entry per week, including the empty ones, so the chart has no gaps.
    const counts = new Map(weeks.map((w) => [w.week.toISOString().slice(0, 10), w.count]));
    const thisWeek = new Date(now);
    thisWeek.setUTCHours(0, 0, 0, 0);
    thisWeek.setUTCDate(thisWeek.getUTCDate() - ((thisWeek.getUTCDay() + 6) % 7));
    const signupsByWeek = Array.from({ length: 12 }, (_, i) => {
      const start = new Date(thisWeek.getTime() - (11 - i) * 7 * DAY_MS);
      const key = start.toISOString().slice(0, 10);
      return { weekStart: key, count: counts.get(key) ?? 0 };
    });

    return {
      businesses,
      newThisMonth,
      signupsByWeek,
      activeLast7Days: active[0]?.count ?? 0,
      atRisk: {
        count: atRisk.length,
        businesses: atRisk.slice(0, 20),
      },
      paymentsThisMonth: paidThis,
      paymentsLastMonth: paidLast,
    };
  }

  private async paymentsBetween(from: Date, to: Date) {
    const rows = await this.prisma.subscriptionPayment.groupBy({
      by: ['currency'],
      where: { createdAt: { gte: from, lt: to } },
      _sum: { amount: true },
      _count: true,
    });
    return rows.map((r) => ({
      currency: r.currency,
      total: round2(Number(r._sum.amount ?? 0)),
      count: r._count,
    }));
  }

  /**
   * Is everything working? Configuration is reported as set / not set --
   * never the values, since this page is one stolen admin session away from
   * whoever holds it.
   */
  async systemStatus() {
    const started = Date.now();
    let database: { ok: boolean; latencyMs: number | null; error: string | null } = {
      ok: true,
      latencyMs: null,
      error: null,
    };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database.latencyMs = Date.now() - started;
    } catch (e) {
      database = { ok: false, latencyMs: null, error: (e as Error).message.slice(0, 300) };
    }

    const [lastMigration, emails24h] = await Promise.all([
      this.prisma
        .$queryRaw<{ name: string; finishedAt: Date }[]>`
          SELECT migration_name AS name, finished_at AS "finishedAt"
          FROM "_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
          ORDER BY migration_name DESC
          LIMIT 1
        `
        .then((r) => r[0] ?? null)
        .catch(() => null),
      database.ok
        ? this.prisma.emailLog.groupBy({
            by: ['status'],
            where: { createdAt: { gte: new Date(Date.now() - DAY_MS) } },
            _count: true,
          })
        : Promise.resolve([] as { status: EmailStatus; _count: number }[]),
    ]);

    const set = (k: string) => !!this.config.get<string>(k)?.trim();
    const transport = (this.config.get<string>('MAIL_TRANSPORT') ?? 'resend').toLowerCase();
    const byStatus = (s: EmailStatus) => emails24h.find((r) => r.status === s)?._count ?? 0;

    return {
      app: {
        version: APP_VERSION,
        // Render sets RENDER_GIT_COMMIT on every deploy.
        commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
        environment: process.env.NODE_ENV ?? 'development',
        node: process.version,
        startedAt: processStartedAt.toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      },
      database: { ...database, lastMigration },
      email: {
        transport,
        configured: transport === 'log' || (set('RESEND_API_KEY') && set('RESEND_FROM')),
        last24h: {
          sent: byStatus(EmailStatus.SENT),
          failed: byStatus(EmailStatus.FAILED),
          logged: byStatus(EmailStatus.LOGGED),
        },
      },
      storage: {
        productImages: set('SUPABASE_URL') && set('SUPABASE_SERVICE_ROLE_KEY') ? 'supabase' : 'local-disk',
      },
      subscriptions: {
        trialDays: await this.settings.trialDays(),
        graceDays: graceDays(),
        supportContactSet: Object.keys(supportContact()).length > 0,
      },
      crons: cronRuns(),
    };
  }

  /** Every email the app tried to send, newest first, searchable by address. */
  async emailLog(q: QueryEmailLogDto) {
    const where: Prisma.EmailLogWhereInput = {
      ...(q.search ? { to: { contains: q.search.trim(), mode: 'insensitive' } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.emailLog.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: { business: { select: { id: true, name: true } } },
      }),
      this.prisma.emailLog.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }
}
