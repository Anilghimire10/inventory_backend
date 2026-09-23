import { Injectable } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

const EXPIRY_WINDOW_DAYS = 30;

interface DesiredAlert {
  type: NotificationType;
  dedupeKey: string;
  title: string;
  body: string;
  link: string;
}

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
  ) {}

  /**
   * List active (non-dismissed) notifications, newest first, plus the unread
   * count.
   *
   * This is a **pure read**. It used to call `sync()` first, which made the
   * single most expensive endpoint in the system out of a bell that every
   * signed-in browser polls once a minute: each poll ran a full low-stock
   * scan, an expiring-batch scan, a `deleteMany` and one sequential `upsert`
   * per alert -- a GET that wrote, multiplied by the number of staff online,
   * against a connection pool capped at 15 clients.
   *
   * Reconciliation now runs on a timer instead (`AlertSyncCron`), so the cost
   * is per business every 10 minutes rather than per user every minute.
   */
  async list(businessId: string) {
    const items = await this.prisma.notification.findMany({
      where: { businessId, dismissedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const unreadCount = items.filter((n) => !n.readAt).length;
    return { items, unreadCount };
  }

  async markRead(businessId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, businessId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async markAllRead(businessId: string) {
    await this.prisma.notification.updateMany({
      where: { businessId, readAt: null, dismissedAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Dismiss (delete) a notification. We soft-dismiss so a still-active auto
   * alert won't immediately reappear on the next reconciliation.
   */
  async dismiss(businessId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, businessId, dismissedAt: null },
      data: { dismissedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Reconcile auto alerts (low stock / expiring) against live inventory:
   *  - create rows for newly-triggered conditions (unread),
   *  - refresh the text of conditions that still hold (preserving read/dismissed),
   *  - delete rows whose condition has resolved.
   * GENERAL notifications are never touched here.
   *
   * Public because `AlertSyncCron` drives it now -- `list()` deliberately does
   * not, see the note there.
   */
  async sync(businessId: string) {
    const [low, expiring] = await Promise.all([
      this.inventory.lowStock(businessId),
      this.inventory.expiringBatches(businessId, { days: EXPIRY_WINDOW_DAYS }),
    ]);

    const desired: DesiredAlert[] = [];

    for (const it of low) {
      const reorder = it.effectiveReorderLevel ?? it.reorderLevel;
      const store = it.store?.name ? ` @ ${it.store.name}` : '';
      desired.push({
        type: NotificationType.LOW_STOCK,
        dedupeKey: `low:${it.storeId}:${it.productId}`,
        title: `Low stock: ${it.product.name}`,
        body: `${it.quantity} left · reorder at ${reorder}${store}`,
        link: '/inventory',
      });
    }

    for (const b of expiring) {
      const when = b.expiryDate
        ? new Date(b.expiryDate).toISOString().slice(0, 10)
        : 'soon';
      desired.push({
        type: NotificationType.EXPIRING,
        dedupeKey: `exp:${b.id}`,
        title: `Expiring soon: ${b.product.name}`,
        body: `${b.quantity} · expires ${when}`,
        link: '/inventory',
      });
    }

    const keys = desired.map((d) => d.dedupeKey);

    // Remove auto alerts whose condition no longer holds.
    await this.prisma.notification.deleteMany({
      where: {
        businessId,
        type: { in: [NotificationType.LOW_STOCK, NotificationType.EXPIRING] },
        dedupeKey: keys.length ? { notIn: keys } : undefined,
      },
    });

    // Upsert current alerts. `update` deliberately leaves readAt/dismissedAt
    // alone.
    //
    // Batched into one `$transaction` rather than awaited one at a time: this
    // was a sequential round trip per alert, so a business sitting on 40
    // low-stock rows paid 40 round trips to Supabase Seoul every sync. The
    // array form pipelines them over a single connection. `upsert` is kept
    // over createMany/updateMany because the create and update halves write
    // different column sets, and the unique `businessId_dedupeKey` is what
    // makes it race-safe against a concurrent sweep.
    if (desired.length) {
      await this.prisma.$transaction(
        desired.map((d) =>
          this.prisma.notification.upsert({
            where: {
              businessId_dedupeKey: { businessId, dedupeKey: d.dedupeKey },
            },
            create: {
              businessId,
              type: d.type,
              title: d.title,
              body: d.body,
              link: d.link,
              dedupeKey: d.dedupeKey,
            },
            update: { title: d.title, body: d.body, link: d.link, type: d.type },
          }),
        ),
      );
    }
  }

  /** Create a one-off (GENERAL) notification — handy for future use. */
  create(businessId: string, data: { title: string; body?: string; link?: string }) {
    return this.prisma.notification.create({
      data: {
        businessId,
        type: NotificationType.GENERAL,
        title: data.title,
        body: data.body,
        link: data.link,
      } satisfies Prisma.NotificationUncheckedCreateInput,
    });
  }
}
