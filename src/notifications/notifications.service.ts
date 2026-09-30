import { Injectable } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

const EXPIRY_WINDOW_DAYS = 30;

/**
 * What one person's bell holds: their business's notices, minus the ones
 * addressed to someone else there (a reply to another person's ticket).
 */
function visibleTo(businessId: string, userId: string): Prisma.NotificationWhereInput {
  return { businessId, OR: [{ userId: null }, { userId }] };
}

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
   * The caller's notifications -- everything sent to their business that they
   * haven't dismissed -- newest first, with *their* read state and unread count.
   *
   * Read and dismissed are per person (`NotificationReceipt`). They used to sit
   * on the shared row, so a cashier opening the bell marked every announcement
   * read for the owner, and a cashier dismissing one hid it from everybody.
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
  async list(businessId: string, userId: string) {
    const rows = await this.prisma.notification.findMany({
      where: {
        ...visibleTo(businessId, userId),
        receipts: { none: { userId, dismissedAt: { not: null } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { receipts: { where: { userId }, select: { readAt: true } } },
    });
    const items = rows.map(({ receipts, ...n }) => ({
      ...n,
      readAt: receipts[0]?.readAt ?? null,
    }));
    const unreadCount = items.filter((n) => !n.readAt).length;
    return { items, unreadCount };
  }

  async markRead(businessId: string, userId: string, id: string) {
    const own = await this.prisma.notification.findFirst({
      where: { id, ...visibleTo(businessId, userId) },
      select: { id: true },
    });
    if (own) await this.stamp(userId, [own.id], 'readAt');
    return { ok: true };
  }

  async markAllRead(businessId: string, userId: string) {
    const unread = await this.prisma.notification.findMany({
      where: {
        ...visibleTo(businessId, userId),
        receipts: {
          none: {
            userId,
            OR: [{ readAt: { not: null } }, { dismissedAt: { not: null } }],
          },
        },
      },
      select: { id: true },
    });
    await this.stamp(userId, unread.map((n) => n.id), 'readAt');
    return { ok: true };
  }

  /**
   * Dismiss a notification -- for the caller only. Soft, so a still-active
   * auto alert won't reappear for them on the next reconciliation.
   */
  async dismiss(businessId: string, userId: string, id: string) {
    const own = await this.prisma.notification.findFirst({
      where: { id, ...visibleTo(businessId, userId) },
      select: { id: true },
    });
    if (own) await this.stamp(userId, [own.id], 'dismissedAt');
    return { ok: true };
  }

  /** Clear the caller's bell: dismiss everything they can see, for them only. */
  async dismissAll(businessId: string, userId: string) {
    const shown = await this.prisma.notification.findMany({
      where: {
        ...visibleTo(businessId, userId),
        receipts: { none: { userId, dismissedAt: { not: null } } },
      },
      select: { id: true },
    });
    await this.stamp(userId, shown.map((n) => n.id), 'dismissedAt');
    return { ok: true, dismissed: shown.length };
  }

  /**
   * Set `field` on this user's receipts for these notifications, keeping the
   * first time it was set. Creates the receipts that don't exist yet and fills
   * the field on those that do; together in one transaction, so a double
   * click can't produce two rows (the unique key) or move the timestamp.
   */
  private async stamp(userId: string, ids: string[], field: 'readAt' | 'dismissedAt') {
    if (!ids.length) return;
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.notificationReceipt.createMany({
        data: ids.map((notificationId) => ({ notificationId, userId, [field]: now })),
        skipDuplicates: true,
      }),
      this.prisma.notificationReceipt.updateMany({
        where: { userId, notificationId: { in: ids }, [field]: null },
        data: { [field]: now },
      }),
    ]);
  }

  /**
   * Reconcile auto alerts (low stock / expiring) against live inventory:
   *  - create rows for newly-triggered conditions (unread),
   *  - refresh the text of conditions that still hold (receipts -- who has read
   *    or dismissed it -- are left alone),
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
        body: `${it.quantity.toString()} left · reorder at ${reorder}${store}`,
        link: '/inventory?tab=low',
      });
    }

    for (const b of expiring) {
      const when = b.expiryDate
        ? new Date(b.expiryDate).toISOString().slice(0, 10)
        : 'soon';
      desired.push({
        type: NotificationType.EXPIRING,
        dedupeKey: `exp:${b.id}`,
        title: `${b.expired ? 'Expired' : 'Expiring soon'}: ${b.product.name}`,
        body: `${b.quantity.toString()} · ${b.expired ? 'expired' : 'expires'} ${when}`,
        link: '/inventory?tab=expiring',
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

    // Upsert current alerts. `update` only refreshes the text, so everyone's
    // receipts (read / dismissed) survive it.
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
