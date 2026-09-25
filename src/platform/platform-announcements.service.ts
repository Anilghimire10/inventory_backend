import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NotificationType, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { SendAnnouncementDto } from './dto/platform.dto';

const ACTION = 'announcement.send';

/**
 * Tell shops something: maintenance, a new feature, a price change. It lands
 * in each shop's notification bell, and optionally in its owners' inboxes.
 *
 * No table of its own: the admin log entry for each send carries the title,
 * body and audience, and doubles as the history.
 */
@Injectable()
export class PlatformAnnouncementsService {
  private readonly logger = new Logger(PlatformAnnouncementsService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private audit: PlatformAuditService,
  ) {}

  async send(actor: Actor, dto: SendAnnouncementDto) {
    const title = dto.title.trim();
    const body = dto.body.trim();
    const selected = dto.businessIds?.length ? Array.from(new Set(dto.businessIds)) : null;

    // Suspended shops are skipped even when picked: nobody there can read it.
    const targets = await this.prisma.business.findMany({
      where: { isSuspended: false, ...(selected ? { id: { in: selected } } : {}) },
      select: { id: true, name: true },
    });
    if (targets.length === 0) {
      throw new BadRequestException('None of the chosen businesses is active');
    }

    await this.prisma.notification.createMany({
      data: targets.map((b) => ({ businessId: b.id, type: NotificationType.GENERAL, title, body })),
    });

    let emailed = 0;
    let failed = 0;
    if (dto.email) {
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
      // has owners in the tens.
      for (const o of owners) {
        try {
          await this.mail.sendAnnouncement(o.email, o.name, names.get(o.businessId) ?? '', title, body);
          emailed++;
        } catch (e) {
          failed++;
          this.logger.warn(`Announcement email to ${o.email} failed: ${(e as Error).message}`);
        }
      }
    }

    await this.audit.record(actor, ACTION, {
      details: {
        title,
        body,
        audience: selected ? 'selected' : 'all',
        businesses: targets.length,
        skipped: selected ? selected.length - targets.length : 0,
        email: !!dto.email,
        emailed,
        failed,
      },
    });
    return { businesses: targets.length, emailed, failed };
  }

  /** Past announcements, newest first, from the admin log. */
  history() {
    return this.prisma.platformAuditLog.findMany({
      where: { action: ACTION },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, adminEmail: true, createdAt: true, details: true },
    });
  }
}
