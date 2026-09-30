import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentClaimStatus, SubscriptionPaymentMethod } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { AuthUser } from '../common/types/auth-user';
import { CreatePaymentClaimDto } from './dto/payment-claim.dto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, planFits, planTooSmall, pricedFor, pricingCurrency } from '../settings/settings.service';
import { graceDays, subscriptionSummary, supportContact } from '../common/subscription';
import { METHOD_LABEL, formatReceiptNo, toReceipt } from './receipt';
import { OnlinePaymentsService } from './online-payments.service';
import { emailAdminsAboutClaim } from './claim-alerts';

const CLAIM_SELECT = {
  id: true,
  amount: true,
  currency: true,
  method: true,
  reference: true,
  months: true,
  planId: true,
  planName: true,
  note: true,
  proofUrl: true,
  status: true,
  rejectReason: true,
  submittedByName: true,
  createdAt: true,
  reviewedAt: true,
} as const;

const claimRow = <T extends { amount: { toString(): string } }>(c: T) => ({ ...c, amount: Number(c.amount) });

/**
 * The shop's own view of its subscription: where it stands, what it has
 * paid, and a receipt for each payment. Owners and managers only -- the same
 * people `/auth/me` tells about it -- since they are the ones who renew.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private mail: MailService,
    private online: OnlinePaymentsService,
  ) {}

  async overview(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { isSubscribed: true, subscribedTo: true, createdAt: true, planId: true, currency: true },
    });
    if (!business) throw new NotFoundException('Business not found');
    const [allPlans, activeStores] = await Promise.all([
      this.settings.plans(),
      this.prisma.store.count({ where: { businessId, isActive: true } }),
    ]);
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
        planName: true,
      },
    });
    const summary = subscriptionSummary(business, payments.length);
    // Each plan in the shop's own currency: NPR, or USD where the plan has it.
    const plans = allPlans.map((p) => pricedFor(p, business.currency));
    const claims = await this.prisma.paymentClaim.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: CLAIM_SELECT,
    });
    const latest = payments[0];
    return {
      ...summary,
      // Always included here, not only when a banner would show: this page
      // is where an owner looks up who to pay, and how.
      contact: supportContact(),
      payment: await this.settings.paymentInfo(),
      // The plans to choose from, the one the shop is on (null: none yet, or
      // since removed), and its branches open -- a plan smaller than that
      // can't be chosen.
      plans,
      currentPlan: plans.find((p) => p.id === business.planId) ?? null,
      activeStores,
      // Pay online with eSewa / Khalti / connectIPS: empty unless plans and a gateway are set up.
      online: await this.online.options(),
      // "I've paid" reports, newest first; at most one is pending.
      claims: claims.map(claimRow),
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
        planName: p.planName,
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

  /**
   * "I've paid": the shop reports a payment for an admin to check and
   * confirm. One pending report at a time -- a second would be the same
   * money reported twice, or a mistake to fix by cancelling the first.
   * Admins are emailed; the report shows on the admin panel either way.
   */
  async createClaim(user: AuthUser, dto: CreatePaymentClaimDto) {
    const needsReference: SubscriptionPaymentMethod[] = [
      SubscriptionPaymentMethod.ESEWA,
      SubscriptionPaymentMethod.KHALTI,
      SubscriptionPaymentMethod.BANK,
    ];
    const reference = dto.reference?.trim() || null;
    if (needsReference.includes(dto.method) && !reference) {
      throw new BadRequestException('Add the transaction ID or bank reference, so we can find your payment');
    }
    const plan = dto.planId ? await this.settings.plan(dto.planId) : null;
    if (dto.planId && !plan) throw new BadRequestException('That plan is no longer offered. Reload the page and pick again.');
    if (plan) {
      const open = await this.prisma.store.count({ where: { businessId: user.businessId, isActive: true } });
      if (!planFits(plan, open)) throw new BadRequestException(planTooSmall(plan, open));
    }
    const [business, author] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: user.businessId }, select: { name: true, currency: true } }),
      this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } }),
    ]);
    if (!business) throw new NotFoundException('Business not found');
    // Check and create under the business row's lock: two quick taps would
    // otherwise both find nothing waiting and both report.
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Business" WHERE id = ${user.businessId} FOR UPDATE`;
      const pending = await tx.paymentClaim.findFirst({
        where: { businessId: user.businessId, status: PaymentClaimStatus.PENDING },
        select: { id: true },
      });
      if (pending) {
        throw new ConflictException('A payment is already waiting for confirmation. Cancel it first to report a different one.');
      }
      return tx.paymentClaim.create({
        data: {
          businessId: user.businessId,
          submittedById: user.userId,
          submittedByName: author?.name ?? user.email,
          amount: dto.amount,
          // What the shop was shown: the plan's price currency for it, else
          // the one its plans are priced in (NPR, or USD outside Nepal).
          currency: plan ? pricedFor(plan, business.currency).currency : pricingCurrency(business.currency),
          method: dto.method,
          reference,
          months: dto.months ?? null,
          planId: plan?.id ?? null,
          planName: plan?.name ?? null,
          note: dto.note?.trim() || null,
          proofUrl: dto.proofUrl ?? null,
        },
        select: CLAIM_SELECT,
      });
    });
    void emailAdminsAboutClaim(this.prisma, this.mail, this.logger, business.name, claim);
    return claimRow(claim);
  }

  /** Withdraw a report still waiting: reported by mistake, or the wrong amount. */
  async cancelClaim(businessId: string, id: string) {
    const res = await this.prisma.paymentClaim.updateMany({
      where: { id, businessId, status: PaymentClaimStatus.PENDING },
      data: { status: PaymentClaimStatus.CANCELLED },
    });
    if (!res.count) throw new NotFoundException('No payment report waiting with that id');
    return { cancelled: true };
  }
}
