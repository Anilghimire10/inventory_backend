import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnlinePaymentStatus, PaymentClaimStatus, PlatformRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminDigest, MailService } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { trackCron } from '../common/cron-status';
import { DAY_MS, graceDays } from '../common/subscription';
import { DEFAULT_TIMEZONE, dayKey, isLocalSlot } from '../common/timezone';
import { METHOD_LABEL } from '../subscription/receipt';

/** Every 15 minutes, on the quarter hour; it sends in the one that is 08:00 in Nepal. */
const DIGEST_SCHEDULE = '0 */15 * * * *';
const DIGEST_HOUR = 8;
/** How many of each list the email names before "and N more". */
const LIST = 10;

const money = (amount: Prisma.Decimal | number, currency: string) =>
  `${currency} ${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nepalDay = (d: Date) => dayKey(DEFAULT_TIMEZONE, d);

/**
 * The admins' morning summary: payments shops say they've made, subscriptions
 * ending this week, shops that locked since yesterday, and support tickets
 * waiting. To every active full admin, at 08:00 Nepal time, and only on a day
 * with something in it -- an email that always arrives stops being read.
 */
@Injectable()
export class PlatformDigestService {
  private readonly logger = new Logger(PlatformDigestService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private settings: SettingsService,
  ) {}

  @Cron(DIGEST_SCHEDULE)
  async tick(now = new Date()) {
    // Only the 08:00 run is recorded, so the System page shows the last real one.
    if (!isLocalSlot(DEFAULT_TIMEZONE, now, DIGEST_HOUR)) return;
    await trackCron('admin-digest', () => this.runDaily(now));
  }

  async runDaily(now = new Date()): Promise<string> {
    const s = await this.settings.get();
    if (!s.adminDigestEnabled) return 'Turned off in Settings';
    const digest = await this.build(now);
    if (!digest.pendingClaims.count && !digest.endingSoon.count && !digest.lockedYesterday.count && !digest.ticketsWaiting) {
      return 'Nothing to report, so nothing sent';
    }
    // Claim today first: with more than one server, only one sends.
    const today = nepalDay(now);
    const claimed = await this.prisma.platformSettings.updateMany({
      where: { id: 1, OR: [{ adminDigestSentOn: null }, { adminDigestSentOn: { not: today } }] },
      data: { adminDigestSentOn: today },
    });
    if (!claimed.count) return 'Already sent today';

    const admins = await this.prisma.platformAdmin.findMany({
      where: { isActive: true, role: PlatformRole.ADMIN },
      select: { email: true, name: true },
    });
    let sent = 0;
    for (const a of admins) {
      try {
        await this.mail.sendAdminDigest(a.email, a.name, digest, this.panelUrl());
        sent++;
      } catch (e) {
        this.logger.warn(`Daily summary to ${a.email} failed: ${(e as Error).message}`);
      }
    }
    return `Sent to ${sent} of ${admins.length} admin(s)`;
  }

  /** Send it to one admin now, whatever the setting and even if empty. */
  async sendTo(adminId: string) {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: adminId }, select: { email: true, name: true } });
    if (!admin) throw new NotFoundException('Admin not found');
    await this.mail.sendAdminDigest(admin.email, admin.name, await this.build(new Date()), this.panelUrl());
    return { sentTo: admin.email };
  }

  /** What the summary says, as of `now`. */
  async build(now: Date): Promise<AdminDigest> {
    const weekAhead = new Date(now.getTime() + 7 * DAY_MS);
    // Locked in the last day: access ends `graceDays` after the end date, so
    // an end date between (now - 1 day - grace) and (now - grace).
    const grace = graceDays() * DAY_MS;
    const lockedFrom = new Date(now.getTime() - DAY_MS - grace);
    const lockedTo = new Date(now.getTime() - grace);
    const live = { isSuspended: false, isSubscribed: true };
    const endingWhere: Prisma.BusinessWhereInput = { ...live, subscribedTo: { gt: now, lte: weekAhead } };
    const lockedWhere: Prisma.BusinessWhereInput = { ...live, subscribedTo: { gt: lockedFrom, lte: lockedTo } };

    const [claims, claimCount, ending, endingCount, locked, lockedCount, tickets, signups, online] = await Promise.all([
      this.prisma.paymentClaim.findMany({
        where: { status: PaymentClaimStatus.PENDING },
        orderBy: { createdAt: 'asc' },
        take: LIST,
        include: { business: { select: { name: true } } },
      }),
      this.prisma.paymentClaim.count({ where: { status: PaymentClaimStatus.PENDING } }),
      this.prisma.business.findMany({
        where: endingWhere,
        orderBy: { subscribedTo: 'asc' },
        take: LIST,
        select: {
          name: true,
          subscribedTo: true,
          _count: { select: { subscriptionPayments: true } },
          subscriptionPayments: { orderBy: { createdAt: 'desc' }, take: 1, select: { amount: true, currency: true } },
        },
      }),
      this.prisma.business.count({ where: endingWhere }),
      this.prisma.business.findMany({
        where: lockedWhere,
        orderBy: { subscribedTo: 'asc' },
        take: LIST,
        select: { name: true, subscribedTo: true },
      }),
      this.prisma.business.count({ where: lockedWhere }),
      // Open tickets where the shop wrote last: the Support badge's rule.
      this.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "SupportTicket" t
        WHERE t.status = 'OPEN'
          AND (SELECT m."fromAdmin" FROM "SupportMessage" m WHERE m."ticketId" = t.id
               ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1) = false`,
      this.prisma.business.count({ where: { createdAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
      this.prisma.onlinePayment.aggregate({
        where: { status: OnlinePaymentStatus.COMPLETED, completedAt: { gte: new Date(now.getTime() - DAY_MS) } },
        _count: true,
        _sum: { amount: true },
      }),
    ]);

    return {
      day: nepalDay(now),
      pendingClaims: {
        count: claimCount,
        items: claims.map((c) => ({
          business: c.business.name,
          amount: money(c.amount, c.currency),
          method: METHOD_LABEL[c.method],
          since: nepalDay(c.createdAt),
        })),
      },
      endingSoon: {
        count: endingCount,
        items: ending.map((b) => {
          const last = b.subscriptionPayments[0];
          return {
            business: b.name,
            endsOn: nepalDay(b.subscribedTo!),
            kind: b._count.subscriptionPayments ? ('paid' as const) : ('trial' as const),
            lastAmount: last ? money(last.amount, last.currency) : null,
          };
        }),
      },
      lockedYesterday: {
        count: lockedCount,
        items: locked.map((b) => ({ business: b.name, endedOn: nepalDay(b.subscribedTo!) })),
      },
      ticketsWaiting: Number(tickets[0]?.n ?? 0),
      newSignups: signups,
      // Online plans are in rupees, so one total.
      paidOnline: { count: online._count, total: online._count ? money(online._sum.amount ?? 0, 'NPR') : null },
    };
  }

  private panelUrl() {
    return process.env.ADMIN_PANEL_URL?.trim() || null;
  }
}
