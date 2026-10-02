import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Announcement, NotificationType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { trackCron } from '../common/cron-status';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { SendAnnouncementDto } from './dto/platform.dto';
import { subscriptionWhere } from './platform.service';
import { RealtimeService } from '../realtime/realtime.service';

const ACTION = 'announcement.send';

/** A scheduled time closer than this is just "now". */
const SCHEDULE_MIN_MS = 60_000;
/** And further out than this is a mistake. */
const SCHEDULE_MAX_MS = 90 * 24 * 60 * 60 * 1000;

/** The shops an audience means, at the moment it is sent. Suspended ones never. */
export function audienceWhere(
  a: Pick<Announcement, 'audience' | 'businessIds'>,
  now: Date,
): Prisma.BusinessWhereInput {
  const base: Prisma.BusinessWhereInput = { isSuspended: false };
  switch (a.audience) {
    case 'all':
      return base;
    case 'selected':
      return { ...base, id: { in: a.businessIds } };
    case 'trial':
    case 'active':
    case 'expiring':
    case 'expired':
      return { AND: [base, subscriptionWhere(a.audience, now, 7)] };
    default:
      throw new BadRequestException(`Unknown audience "${a.audience}"`);
  }
}

/**
 * Tell shops something: maintenance, a new feature, a price change. It lands
 * in each shop's notification bell, and optionally in its owners' inboxes --
 * now, or at a time set in advance.
 *
 * Each notification carries the announcement's id, and read state is per
 * person (`NotificationReceipt`), so the history can say how many shops have
 * actually seen it.
 */
@Injectable()
export class PlatformAnnouncementsService {
  private readonly logger = new Logger(PlatformAnnouncementsService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private audit: PlatformAuditService,
    private realtime: RealtimeService,
  ) {}

  async send(actor: Actor, dto: SendAnnouncementDto) {
    const title = dto.title.trim();
    const body = dto.body.trim();
    const selected = dto.businessIds?.length ? Array.from(new Set(dto.businessIds)) : [];
    // Picking shops *is* the "selected" audience; otherwise default to all.
    const audience = selected.length ? 'selected' : (dto.audience ?? 'all');
    if (audience === 'selected' && !selected.length) {
      throw new BadRequestException('Choose at least one business');
    }

    const now = new Date();
    let scheduledFor: Date | null = null;
    if (dto.scheduledFor) {
      scheduledFor = new Date(dto.scheduledFor);
      const ahead = scheduledFor.getTime() - now.getTime();
      if (ahead > SCHEDULE_MAX_MS) throw new BadRequestException('Schedule it within 90 days');
      if (ahead < SCHEDULE_MIN_MS) scheduledFor = null; // in the past or right now: send now
    }

    const announcement = await this.prisma.announcement.create({
      data: {
        title,
        body,
        audience,
        businessIds: audience === 'selected' ? selected : [],
        email: !!dto.email,
        createdByEmail: actor.email,
        scheduledFor,
        // Sent straight away: claimed at birth so the job never picks it up.
        sentAt: scheduledFor ? null : now,
      },
    });

    if (scheduledFor) {
      // Nobody is reached yet, but say so up front: a scheduled "selected"
      // send whose shops are all suspended would otherwise fail silently later.
      const reach = await this.prisma.business.count({ where: audienceWhere(announcement, now) });
      await this.audit.record(actor, 'announcement.schedule', {
        details: { announcementId: announcement.id, title, audience, scheduledFor: scheduledFor.toISOString(), reach },
      });
      return { scheduled: true as const, id: announcement.id, scheduledFor, businesses: reach, emailed: 0, failed: 0 };
    }

    const result = await this.deliver(announcement, actor);
    if (result.businesses === 0) {
      // Nothing went out; don't leave a "sent" record that reached nobody.
      await this.prisma.announcement.delete({ where: { id: announcement.id } });
      throw new BadRequestException('None of the chosen businesses is active');
    }
    return { scheduled: false as const, id: announcement.id, ...result };
  }

  /**
   * Put it in the bells (and inboxes) of whoever the audience means right
   * now. `sentAt` is already set by the caller; this records what happened.
   */
  private async deliver(a: Announcement, actor: Actor) {
    const now = new Date();
    const targets = await this.prisma.business.findMany({
      where: audienceWhere(a, now),
      select: { id: true, name: true },
    });

    if (targets.length) {
      await this.prisma.notification.createMany({
        data: targets.map((b) => ({
          businessId: b.id,
          type: NotificationType.GENERAL,
          title: a.title,
          body: a.body,
          announcementId: a.id,
        })),
      });
      // Straight into the bells of whoever has the app open.
      this.realtime.emitMany(targets.map((b) => b.id), ['notifications']);
    }

    let emailed = 0;
    let failed = 0;
    if (a.email && targets.length) {
      const names = new Map(targets.map((b) => [b.id, b.name]));
      const owners = await this.prisma.user.findMany({
        where: {
          businessId: { in: targets.map((b) => b.id) },
          role: UserRole.OWNER,
          isActive: true,
          emailVerified: true,
        },
        select: { email: true, name: true, businessId: true },
      });
      // One at a time: the mail provider rate-limits, and a platform this size
      // has owners in the tens. (Queue these before it has hundreds.)
      for (const o of owners) {
        try {
          await this.mail.sendAnnouncement(o.email, o.name, names.get(o.businessId) ?? '', a.title, a.body);
          emailed++;
        } catch (e) {
          failed++;
          this.logger.warn(`Announcement email to ${o.email} failed: ${(e as Error).message}`);
        }
      }
    }

    await this.prisma.announcement.update({
      where: { id: a.id },
      data: { businesses: targets.length, emailed, failed },
    });
    await this.audit.record(actor, ACTION, {
      details: {
        announcementId: a.id,
        title: a.title,
        body: a.body,
        audience: a.audience,
        businesses: targets.length,
        skipped: a.audience === 'selected' ? a.businessIds.length - targets.length : 0,
        email: a.email,
        emailed,
        failed,
        ...(a.scheduledFor ? { scheduledFor: a.scheduledFor.toISOString() } : {}),
      },
    });
    return { businesses: targets.length, emailed, failed };
  }

  /** Stop a scheduled one before it goes out. */
  async cancel(actor: Actor, id: string) {
    const claimed = await this.prisma.announcement.updateMany({
      where: { id, sentAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });
    if (claimed.count === 0) {
      const a = await this.prisma.announcement.findUnique({ where: { id }, select: { id: true } });
      if (!a) throw new NotFoundException('Announcement not found');
      throw new BadRequestException('It has already gone out, or was cancelled');
    }
    await this.audit.record(actor, 'announcement.cancel', { details: { announcementId: id } });
    return { ok: true };
  }

  /**
   * Send whatever is due. Every minute; each one is claimed by setting
   * `sentAt` in a guarded update first, so a second server running the same
   * job can't send it twice.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  runDue() {
    return trackCron('scheduled-announcements', async () => {
      const due = await this.prisma.announcement.findMany({
        where: { scheduledFor: { lte: new Date() }, sentAt: null, cancelledAt: null },
        orderBy: { scheduledFor: 'asc' },
        take: 20,
      });
      let sent = 0;
      for (const a of due) {
        const claimed = await this.prisma.announcement.updateMany({
          where: { id: a.id, sentAt: null, cancelledAt: null },
          data: { sentAt: new Date() },
        });
        if (claimed.count === 0) continue;
        try {
          await this.deliver(a, { adminId: null, email: a.createdByEmail });
          sent++;
        } catch (e) {
          this.logger.error(`Scheduled announcement ${a.id} failed: ${(e as Error).message}`);
        }
      }
      return `${sent} sent`;
    });
  }

  /**
   * Newest first: scheduled ones still waiting, then what went out, each with
   * how many of the shops it reached have seen it -- at least one person there
   * has opened it in their bell.
   */
  async history() {
    const list = await this.prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const ids = list.map((a) => a.id);
    const seen = ids.length
      ? await this.prisma.$queryRaw<{ id: string; shops: bigint; people: bigint }[]>`
          SELECT n."announcementId" AS id,
                 COUNT(DISTINCT n."businessId") AS shops,
                 COUNT(DISTINCT r."userId") AS people
          FROM "Notification" n
          JOIN "NotificationReceipt" r ON r."notificationId" = n."id" AND r."readAt" IS NOT NULL
          WHERE n."announcementId" IN (${Prisma.join(ids)})
          GROUP BY n."announcementId"
        `
      : [];
    const byId = new Map(seen.map((s) => [s.id, s]));
    return list.map((a) => ({
      ...a,
      status: a.cancelledAt ? 'cancelled' : a.sentAt ? 'sent' : 'scheduled',
      seenByShops: Number(byId.get(a.id)?.shops ?? 0),
      seenByPeople: Number(byId.get(a.id)?.people ?? 0),
    }));
  }
}
