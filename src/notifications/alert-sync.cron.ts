import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

/**
 * Reconciles every active business's auto alerts (low stock / expiring) on a
 * timer.
 *
 * This work used to happen inside `GET /notifications`, which the bell in the
 * web app polls once a minute per signed-in user. That made a read endpoint
 * write, and multiplied the whole scan-and-upsert pass by the number of staff
 * online -- eight tills open meant eight reconciliations a minute against a
 * pooler capped at 15 clients. Driving it from here makes the cost a function
 * of how many businesses exist, not how many browsers are open.
 *
 * Ten minutes is the staleness the bell now carries: an alert can lag the
 * stock movement that caused it by that much. That is the trade for the
 * endpoint being a plain SELECT, and it is well inside the reaction time of a
 * reorder decision. Sales, adjustments and receipts could call `sync()`
 * themselves for an immediate alert, but `NotificationsService` depends on
 * `InventoryService`, so wiring the reverse edge would need a `forwardRef`
 * through most of the stock path -- not worth it for the few minutes saved.
 */
@Injectable()
export class AlertSyncCron {
  private readonly logger = new Logger(AlertSyncCron.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncAll() {
    const businesses = await this.prisma.business.findMany({
      where: { isSuspended: false },
      select: { id: true },
    });

    let failed = 0;
    // Sequential on purpose. The pool is small and each sync is several
    // queries; fanning every tenant out at once would starve live requests
    // for the length of the sweep.
    for (const b of businesses) {
      try {
        await this.notifications.sync(b.id);
      } catch (e) {
        failed++;
        this.logger.warn(
          `Alert sync failed for business ${b.id}: ${(e as Error).message}`,
        );
      }
    }

    if (failed) {
      this.logger.warn(
        `Alert sync run complete — ${businesses.length - failed}/${businesses.length} business(es) reconciled.`,
      );
    }
  }
}
