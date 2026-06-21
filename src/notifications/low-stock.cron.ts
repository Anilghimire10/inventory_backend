import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { MailService } from '../mail/mail.service';

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

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async runDailyDigest() {
    const businesses = await this.prisma.business.findMany({
      where: { isSuspended: false },
      select: { id: true },
    });
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
    this.logger.log(`Low-stock digest run complete — emailed ${sent} business(es).`);
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
      quantity: it.quantity,
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
