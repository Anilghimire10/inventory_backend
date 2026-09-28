import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SubscriptionPaymentMethod, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService, SubscriptionReceipt } from '../mail/mail.service';
import { SettingsService } from '../settings/settings.service';
import { DAY_MS, accessEndsAt, daysUntil } from '../common/subscription';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { SubscriptionRemindersService } from './subscription-reminders.service';

const METHOD_LABEL: Record<SubscriptionPaymentMethod, string> = {
  CASH: 'Cash',
  BANK: 'Bank transfer',
  ESEWA: 'eSewa',
  KHALTI: 'Khalti',
  OTHER: 'Other',
};

/** SUB-000042: the receipt number as printed. */
export const formatReceiptNo = (n: number) => `SUB-${String(n).padStart(6, '0')}`;

/**
 * Getting paid: receipts for recorded subscription payments, and the list of
 * shops whose subscription is about to end (or has) with a bulk reminder.
 */
@Injectable()
export class PlatformBillingService {
  private readonly logger = new Logger(PlatformBillingService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private settings: SettingsService,
    private audit: PlatformAuditService,
    private reminders: SubscriptionRemindersService,
  ) {}

  /**
   * Everything a receipt shows. The seller is the platform, from Settings;
   * the payer's note stays off it -- that field is for admins.
   */
  async receipt(paymentId: string): Promise<SubscriptionReceipt> {
    const p = await this.prisma.subscriptionPayment.findUnique({
      where: { id: paymentId },
      include: { business: { select: { id: true, name: true, taxId: true } } },
    });
    if (!p) throw new NotFoundException('Payment not found');
    const s = await this.settings.get();
    return {
      receiptNo: formatReceiptNo(p.receiptNo),
      issuedAt: p.createdAt,
      seller: {
        name: s.billingName,
        taxId: s.billingTaxId,
        address: s.billingAddress,
        phone: s.billingPhone,
        email: s.billingEmail,
      },
      buyer: { businessId: p.business.id, name: p.business.name, taxId: p.business.taxId },
      amount: Number(p.amount),
      currency: p.currency,
      methodLabel: METHOD_LABEL[p.method],
      reference: p.reference,
      periodFrom: p.periodFrom,
      periodTo: p.periodTo,
    };
  }

  /**
   * Email the receipt to the business's owners -- verified and active only,
   * the same people subscription reminders go to. One at a time: a business
   * has one or two owners.
   */
  async emailReceipt(actor: Actor, paymentId: string) {
    const r = await this.receipt(paymentId);
    const owners = await this.prisma.user.findMany({
      where: {
        businessId: r.buyer.businessId,
        role: UserRole.OWNER,
        isActive: true,
        emailVerified: true,
      },
      select: { email: true, name: true },
    });
    if (!owners.length) {
      throw new BadRequestException('This business has no verified, active owner to email');
    }
    let emailed = 0;
    let failed = 0;
    for (const o of owners) {
      try {
        await this.mail.sendSubscriptionReceipt(o.email, o.name, r);
        emailed++;
      } catch (e) {
        failed++;
        this.logger.warn(`Receipt ${r.receiptNo} to ${o.email} failed: ${(e as Error).message}`);
      }
    }
    await this.audit.record(actor, 'payment.receipt.email', {
      businessId: r.buyer.businessId,
      details: { paymentId, receiptNo: r.receiptNo, emailed, failed },
    });
    return { receiptNo: r.receiptNo, emailed, failed };
  }

  /**
   * Shops to chase: every subscription (trial or paid) ending within `days`,
   * and every one already past its end date, soonest first. Suspended shops
   * and ones switched off by an admin are left out -- there's nothing to renew.
   *
   * Each row carries the last payment, which is what a renewal normally costs.
   */
  async renewals(days: number) {
    const now = new Date();
    const until = new Date(now.getTime() + days * DAY_MS);
    const rows = await this.prisma.business.findMany({
      where: {
        isSuspended: false,
        isSubscribed: true,
        subscribedTo: { not: null, lte: until },
      },
      orderBy: [{ subscribedTo: 'asc' }, { id: 'asc' }],
      take: 500,
      select: {
        id: true,
        name: true,
        currency: true,
        subscribedTo: true,
        _count: { select: { subscriptionPayments: true } },
        subscriptionPayments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { amount: true, currency: true, periodFrom: true, periodTo: true, createdAt: true },
        },
        users: {
          where: { role: UserRole.OWNER, isActive: true },
          select: { name: true, email: true, emailVerified: true },
          take: 3,
        },
      },
    });
    return rows.map((b) => {
      const end = b.subscribedTo!;
      const last = b.subscriptionPayments[0];
      return {
        id: b.id,
        name: b.name,
        endsAt: end,
        // When they actually get locked out, after the grace period.
        accessEndsAt: accessEndsAt(end),
        daysLeft: daysUntil(end, now),
        overdue: end.getTime() < now.getTime(),
        kind: b._count.subscriptionPayments === 0 ? ('trial' as const) : ('paid' as const),
        lastPayment: last
          ? {
              amount: Number(last.amount),
              currency: last.currency,
              periodFrom: last.periodFrom,
              periodTo: last.periodTo,
              paidAt: last.createdAt,
            }
          : null,
        owners: b.users,
      };
    });
  }

  /**
   * "Remind selected": the same reminder as a business page's button -- a
   * bell notification plus an email to the owners -- for each business in
   * turn, each written to its own admin log entry. Businesses with no end
   * date are skipped rather than failing the batch.
   */
  async remind(actor: Actor, businessIds: string[]) {
    const ids = Array.from(new Set(businessIds));
    const businesses = await this.prisma.business.findMany({
      where: { id: { in: ids }, subscribedTo: { not: null } },
      select: { id: true, name: true, subscribedTo: true },
    });
    let emailed = 0;
    let failed = 0;
    for (const b of businesses) {
      const daysLeft = daysUntil(b.subscribedTo!);
      const res = await this.reminders.remind(
        { id: b.id, name: b.name, subscribedTo: b.subscribedTo! },
        daysLeft,
        true,
      );
      emailed += res.emailed;
      failed += res.failed;
      await this.audit.record(actor, 'subscription.remind', {
        businessId: b.id,
        details: { daysLeft, emailed: res.emailed, failed: res.failed, bulk: true },
      });
    }
    return {
      reminded: businesses.length,
      skipped: ids.length - businesses.length,
      emailed,
      failed,
    };
  }
}
