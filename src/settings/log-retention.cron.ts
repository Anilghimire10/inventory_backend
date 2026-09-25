import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { trackCron } from '../common/cron-status';
import { SettingsService } from './settings.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows per delete, so a first run over a long history never holds one huge lock. */
const BATCH = 5000;

/**
 * Deletes shop activity-log (AuditLog) entries older than the retention the
 * admin set on the Settings page. Off (null) by default: nothing is removed
 * until someone chooses a period.
 *
 * The admin log (PlatformAuditLog) is never pruned -- it is the record of what
 * admins did to shops, including this.
 */
@Injectable()
export class LogRetentionCron {
  private readonly logger = new Logger(LogRetentionCron.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  /** The cut-off for a retention period, or null when logs are kept forever. */
  static cutoff(days: number | null, now = new Date()): Date | null {
    return days == null ? null : new Date(now.getTime() - days * DAY_MS);
  }

  @Cron('0 30 3 * * *')
  run(now = new Date()) {
    return trackCron('log-retention', async () => {
      const cutoff = LogRetentionCron.cutoff((await this.settings.get()).auditRetentionDays, now);
      if (!cutoff) return 'retention off';
      let removed = 0;
      for (;;) {
        // Typed queries, not raw SQL: see TASKS.md T29 on raw date bounds.
        const ids = await this.prisma.auditLog.findMany({
          where: { createdAt: { lt: cutoff } },
          select: { id: true },
          take: BATCH,
        });
        if (ids.length === 0) break;
        const { count } = await this.prisma.auditLog.deleteMany({
          where: { id: { in: ids.map((r) => r.id) } },
        });
        removed += count;
        if (ids.length < BATCH) break;
      }
      if (removed) this.logger.log(`Removed ${removed} activity-log entries before ${cutoff.toISOString()}`);
      return `removed ${removed} before ${cutoff.toISOString().slice(0, 10)}`;
    });
  }
}
