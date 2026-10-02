import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription, filter, groupBy, mergeMap, throttleTime } from 'rxjs';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from './notifications.service';

/** A busy till is reconciled at most this often, a few seconds after its last change. */
const SETTLE_MS = 10_000;

/**
 * Low-stock and expiry alerts within seconds of the stock change that causes
 * them, instead of at the next ten-minute sweep (AlertSyncCron, which stays
 * as the safety net).
 *
 * Listens on the live-update bus for "stock" changes, so the sale and stock
 * paths don't need to know about notifications at all (the reverse edge was
 * why this used to wait for the timer). Per business, throttled with a
 * trailing run: ten sales in a burst cost one reconciliation, after the last.
 */
@Injectable()
export class AlertTrigger implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertTrigger.name);
  private sub?: Subscription;

  constructor(
    private realtime: RealtimeService,
    private notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.sub = this.realtime
      .all()
      .pipe(
        filter((e) => e.topics.includes('stock')),
        groupBy((e) => e.businessId),
        mergeMap((g) => g.pipe(throttleTime(SETTLE_MS, undefined, { leading: false, trailing: true }))),
      )
      .subscribe((e) => {
        this.notifications
          .sync(e.businessId)
          .catch((err: Error) => this.logger.warn(`Alert sync for ${e.businessId} failed: ${err.message}`));
      });
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
  }
}
