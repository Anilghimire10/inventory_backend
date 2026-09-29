import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { graceDays, subscriptionSummary, supportContact } from '../common/subscription';
import { METHOD_LABEL, formatReceiptNo, toReceipt } from './receipt';

/**
 * The shop's own view of its subscription: where it stands, what it has
 * paid, and a receipt for each payment. Owners and managers only -- the same
 * people `/auth/me` tells about it -- since they are the ones who renew.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {}

  async overview(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { isSubscribed: true, subscribedTo: true, createdAt: true },
    });
    if (!business) throw new NotFoundException('Business not found');
    const payments = await this.prisma.subscriptionPayment.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        receiptNo: true,
        createdAt: true,
        amount: true,
        currency: true,
        method: true,
        reference: true,
        periodFrom: true,
        periodTo: true,
      },
    });
    const summary = subscriptionSummary(business, payments.length);
    const latest = payments[0];
    return {
      ...summary,
      // Always included here, not only when a banner would show: this page
      // is where an owner looks up who to pay.
      contact: supportContact(),
      hasEndDate: !!(business.isSubscribed && business.subscribedTo),
      // A real trial: an end date and never paid. A shop with no end date and
      // no payments isn't on trial -- it has nothing to renew.
      trial: summary.status === 'trial',
      // Where the current period began, for the progress bar: the latest
      // payment's cover, or signup for a trial.
      periodStart: latest ? latest.periodFrom.toISOString() : business.createdAt.toISOString(),
      graceDays: graceDays(),
      payments: payments.map((p) => ({
        id: p.id,
        receiptNo: formatReceiptNo(p.receiptNo),
        paidAt: p.createdAt,
        amount: Number(p.amount),
        currency: p.currency,
        method: METHOD_LABEL[p.method],
        reference: p.reference,
        periodFrom: p.periodFrom,
        periodTo: p.periodTo,
      })),
    };
  }

  /** One of this shop's receipts. Another shop's payment id is a 404. */
  async receipt(businessId: string, paymentId: string) {
    const p = await this.prisma.subscriptionPayment.findFirst({
      where: { id: paymentId, businessId },
      include: { business: { select: { id: true, name: true, taxId: true } } },
    });
    if (!p) throw new NotFoundException('Payment not found');
    return toReceipt(p, await this.settings.get());
  }
}
