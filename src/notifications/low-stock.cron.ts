import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { MailService } from '../mail/mail.service';
import { trackCron } from '../common/cron-status';
import { isLocalSlot } from '../common/timezone';

/** Every 15 minutes, on the quarter hour. See `isLocalSlot` for why not hourly. */
export const DIGEST_SCHEDULE = '0 */15 * * * *';
/** Local hour the digest goes out. */
export const DIGEST_HOUR = 8;

/**
 * Emails each business owner a once-a-day digest of items that have fallen to
 * or below their reorder level. Mail failures (e.g. Resend not configured)
 * are logged and never throw, so one tenant can't break the run for others.
 */
@Injectable()
export class LowStockCron {
  private readonly logger = new Logger(LowStockCron.name);

  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private mail: MailService,
  ) {}

  /**
   * 08:00 in each shop's own time zone, not the server's. This was
   * EVERY_DAY_AT_8AM, which on a UTC host is 13:45 in Kathmandu -- a
   * "morning" restock digest arriving after lunch. Runs every quarter hour
   * and picks out the businesses whose clock has just reached 8.
   */
  @Cron(DIGEST_SCHEDULE)
  runDailyDigest(now = new Date()) {
    return trackCron('low-stock-digest', async () => {
      const all = await this.prisma.business.findMany({
        where: { isSuspended: false },
        select: { id: true, timezone: true },
      });
      const businesses = all.filter((b) => isLocalSlot(b.timezone, now, DIGEST_HOUR));
      let sent = 0;
      for (const b of businesses) {
        try {
          if (await this.sendForBusiness(b.id)) sent++;
        } catch (e) {
          this.logger.warn(
            `Low-stock digest failed for business ${b.id}: ${(e as Error).message}`,
          );
        }
      }
      const summary = `Emailed ${sent} of ${businesses.length} business(es) at 08:00 local`;
      // Most quarter hours reach nobody's 8am; only log the runs that did.
      if (businesses.length) this.logger.log(`Low-stock digest run complete — ${summary}.`);
      return summary;
    });
  }

  /**
   * Send the digest for one business to all its owners. Returns true if there
   * were low-stock items to report. Throws if email delivery fails.
   */
  async sendForBusiness(businessId: string): Promise<boolean> {
    const low = await this.inventory.lowStock(businessId);
    if (low.length === 0) return false;

    const [business, owners] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true },
      }),
      this.prisma.user.findMany({
        where: { businessId, role: UserRole.OWNER, isActive: true },
        select: { email: true, name: true },
      }),
    ]);

    const items = low.map((it) => ({
      productName: it.product.name,
      sku: it.product.sku,
      quantity: Number(it.quantity),
      reorderLevel: it.effectiveReorderLevel ?? it.reorderLevel,
      storeName: it.store?.name ?? null,
    }));

    for (const owner of owners) {
      await this.mail.sendLowStockDigest(
        owner.email,
        owner.name,
        business?.name ?? 'your business',
        items,
      );
    }
    return true;
  }
}
