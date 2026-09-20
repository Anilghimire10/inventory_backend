import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { DAY_MS, daysUntil } from '../common/subscription';

/** Days before the end date (0 = the day it ends) that owners hear about it. */
export const REMIND_AT_DAYS = [7, 3, 1, 0];

interface RemindTarget {
  id: string;
  name: string;
  subscribedTo: Date;
}

/**
 * Tells a business its subscription is ending: a notification in the app's
 * bell plus an email to every active owner. Runs daily on its own, and on
 * demand from the admin panel.
 */
@Injectable()
export class SubscriptionRemindersService {
  private readonly logger = new Logger(SubscriptionRemindersService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async runDaily(now = new Date()) {
    const due = await this.prisma.business.findMany({
      where: {
        isSubscribed: true,
        isSuspended: false,
        subscribedTo: {
          gte: new Date(now.getTime() - DAY_MS),
          lte: new Date(now.getTime() + (Math.max(...REMIND_AT_DAYS) + 1) * DAY_MS),
        },
      },
      select: { id: true, name: true, subscribedTo: true },
    });
    let reminded = 0;
    for (const b of due) {
      const daysLeft = daysUntil(b.subscribedTo!, now);
      if (!REMIND_AT_DAYS.includes(daysLeft)) continue;
      try {
        const res = await this.remind({ ...b, subscribedTo: b.subscribedTo! }, daysLeft);
        if (!res.alreadySent) reminded++;
      } catch (e) {
        this.logger.warn(`Subscription reminder failed for ${b.id}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`Subscription reminders sent to ${reminded} business(es).`);
  }

  /**
   * Notify one business. Automatic reminders are deduplicated on
   * (end date, days left) through the notification's unique dedupeKey, so a
   * restart or a second run the same day sends nothing twice. `force` (the
   * admin's "send now") always sends.
   */
  async remind(b: RemindTarget, daysLeft: number, force = false) {
    const date = b.subscribedTo.toISOString().slice(0, 10);
    try {
      await this.prisma.notification.create({
        data: {
          businessId: b.id,
          type: NotificationType.GENERAL,
          title:
            daysLeft > 0
              ? `Subscription ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
              : 'Subscription has ended',
          body: `Paid until ${date}. Contact us to renew.`,
          dedupeKey: force ? null : `subscription:${date}:${daysLeft}`,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { alreadySent: true, emailed: 0, failed: 0 };
      }
      throw e;
    }

    const owners = await this.prisma.user.findMany({
      where: { businessId: b.id, role: UserRole.OWNER, isActive: true },
      select: { email: true, name: true },
    });
    let emailed = 0;
    let failed = 0;
    for (const o of owners) {
      try {
        await this.mail.sendSubscriptionReminder(o.email, o.name, b.name, b.subscribedTo, daysLeft);
        emailed++;
      } catch (e) {
        failed++;
        this.logger.warn(`Reminder email to ${o.email} failed: ${(e as Error).message}`);
      }
    }
    return { alreadySent: false, emailed, failed };
  }
}
