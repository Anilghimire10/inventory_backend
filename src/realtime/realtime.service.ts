import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

/**
 * What changed, coarsely. A client maps each topic to the screens it should
 * reload; the event itself carries no business data, so nothing leaks to a
 * tab that couldn't have read it anyway.
 */
export type LiveTopic =
  | 'sales'
  | 'stock'
  | 'catalog'
  | 'customers'
  | 'purchases'
  | 'shifts'
  | 'notifications'
  | 'subscription'
  | 'support'
  | 'settings';

export interface ShopEvent {
  businessId: string;
  topics: LiveTopic[];
  /** Only this person's tabs (their own read/dismiss, a reply to their ticket). */
  userId?: string;
  /** The tab that caused it (its X-Client-Id), which has refreshed itself already. */
  origin?: string;
}

/** For the admin panel: a shop asked something or reported a payment. */
export type AdminTopic = 'support' | 'claims' | 'businesses';

/**
 * The live-update bus. Services and the change interceptor publish here; the
 * SSE endpoints (`GET /api/events`, `GET /api/admin/events`) stream it out.
 *
 * In-process: right for the single instance this runs as. Running several
 * instances would need the bus moved to something they share (Postgres
 * LISTEN/NOTIFY, Redis), or a tab would only hear changes made through the
 * instance it happens to be connected to.
 */
@Injectable()
export class RealtimeService {
  private readonly shop = new Subject<ShopEvent>();
  private readonly admin = new Subject<AdminTopic[]>();

  /** Tell a business's open tabs that something changed. */
  emit(event: ShopEvent) {
    if (event.topics.length) this.shop.next(event);
  }

  /** The same, for several businesses at once (an announcement). */
  emitMany(businessIds: string[], topics: LiveTopic[]) {
    for (const businessId of new Set(businessIds)) this.emit({ businessId, topics });
  }

  emitAdmin(topics: AdminTopic[]) {
    if (topics.length) this.admin.next(topics);
  }

  /** What one signed-in person should hear: their business, minus other people's personal events. */
  forUser(businessId: string, userId: string): Observable<ShopEvent> {
    return this.shop.pipe(filter((e) => e.businessId === businessId && (!e.userId || e.userId === userId)));
  }

  /** Every shop event, for server-side listeners (the alert trigger). */
  all(): Observable<ShopEvent> {
    return this.shop.asObservable();
  }

  forAdmins(): Observable<AdminTopic[]> {
    return this.admin.asObservable();
  }
}
