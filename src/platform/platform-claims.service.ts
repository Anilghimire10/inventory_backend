import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentClaimStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { paginate } from '../common/dto/pagination.dto';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { PlatformService } from './platform.service';
import { ConfirmPaymentClaimDto, QueryPaymentClaimsDto } from './dto/platform.dto';
import { RealtimeService } from '../realtime/realtime.service';

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Payment reports from shops ("I've paid"): the admin checks each against
 * the eSewa, Khalti or bank statement, then confirms it -- which records the
 * payment exactly as Record payment does, extending the subscription and
 * sending the receipt -- or rejects it with a reason the shop sees.
 */
@Injectable()
export class PlatformClaimsService {
  constructor(
    private prisma: PrismaService,
    private platform: PlatformService,
    private audit: PlatformAuditService,
    private settings: SettingsService,
    private realtime: RealtimeService,
  ) {}

  async list(q: QueryPaymentClaimsDto) {
    const where: Prisma.PaymentClaimWhereInput = { status: q.status ?? PaymentClaimStatus.PENDING };
    const [rows, total, pending] = await Promise.all([
      this.prisma.paymentClaim.findMany({
        where,
        // Waiting ones oldest first -- first in, first checked; the rest newest first.
        orderBy: { createdAt: where.status === PaymentClaimStatus.PENDING ? 'asc' : 'desc' },
        skip: q.skip,
        take: q.limit,
        include: {
          business: { select: { id: true, name: true, currency: true, isSubscribed: true, subscribedTo: true } },
          reviewedBy: { select: { name: true } },
          payment: { select: { id: true, receiptNo: true } },
        },
      }),
      this.prisma.paymentClaim.count({ where }),
      this.prisma.paymentClaim.count({ where: { status: PaymentClaimStatus.PENDING } }),
    ]);
    return {
      ...paginate(rows.map((r) => ({ ...r, amount: Number(r.amount) })), total, q.page, q.limit),
      pendingCount: pending,
    };
  }

  /**
   * Record the payment and mark the report confirmed. The report is taken
   * first (PENDING -> CONFIRMED in one guarded update), so two admins
   * confirming at once can't record the money twice; if recording then
   * fails, it goes back to waiting.
   */
  async confirm(actor: Actor, id: string, dto: ConfirmPaymentClaimDto) {
    const claim = await this.findOrThrow(id);
    const taken = await this.prisma.paymentClaim.updateMany({
      where: { id, status: PaymentClaimStatus.PENDING },
      data: { status: PaymentClaimStatus.CONFIRMED, reviewedByAdminId: actor.adminId, reviewedAt: new Date() },
    });
    if (!taken.count) throw new ConflictException(`This report was already ${claim.status.toLowerCase()}`);

    let recorded: Awaited<ReturnType<PlatformService['recordPayment']>>;
    try {
      recorded = await this.platform.recordPayment(actor, claim.businessId, {
        amount: dto.amount ?? Number(claim.amount),
        currency: claim.currency,
        method: claim.method,
        reference: claim.reference ?? undefined,
        ...(dto.periodTo ? { periodTo: dto.periodTo } : { months: dto.months ?? claim.months ?? 1 }),
        // The plan the admin picked, else the one the shop said -- unless
        // that one has since been removed, which mustn't block the money.
        ...(dto.planId
          ? { planId: dto.planId }
          : (await this.settings.plan(claim.planId))
            ? { planId: claim.planId! }
            : {}),
        note: `Reported by ${claim.submittedByName}${claim.note ? `: ${claim.note}` : ''}`,
        emailReceipt: dto.emailReceipt ?? true,
      });
    } catch (e) {
      await this.prisma.paymentClaim.update({
        where: { id },
        data: { status: PaymentClaimStatus.PENDING, reviewedByAdminId: null, reviewedAt: null },
      });
      throw e;
    }

    const end = recorded.business.subscribedTo;
    await this.prisma.$transaction([
      this.prisma.paymentClaim.update({ where: { id }, data: { paymentId: recorded.payment.id } }),
      // To whoever reported it (the whole shop if they've since been removed).
      this.prisma.notification.create({
        data: {
          businessId: claim.businessId,
          userId: claim.submittedById,
          title: 'Payment confirmed',
          body: end
            ? `Thank you. Your subscription now runs to ${dayOf(end)}. The receipt is on the Subscription page.`
            : 'Thank you. The receipt is on the Subscription page.',
          link: '/subscription',
        },
      }),
    ]);
    this.realtime.emit({ businessId: claim.businessId, topics: ['notifications', 'subscription'] });
    this.realtime.emitAdmin(['claims', 'businesses']);
    await this.audit.record(actor, 'payment.claim.confirm', {
      businessId: claim.businessId,
      details: { claimId: id, paymentId: recorded.payment.id, amount: Number(recorded.payment.amount) },
    });
    return { claimId: id, payment: recorded.payment, business: recorded.business, receipt: recorded.receipt };
  }

  /** Couldn't find the money: tell the shop why, so they can check and report again. */
  async reject(actor: Actor, id: string, reason: string) {
    const claim = await this.findOrThrow(id);
    const text = reason.trim();
    const taken = await this.prisma.paymentClaim.updateMany({
      where: { id, status: PaymentClaimStatus.PENDING },
      data: {
        status: PaymentClaimStatus.REJECTED,
        rejectReason: text,
        reviewedByAdminId: actor.adminId,
        reviewedAt: new Date(),
      },
    });
    if (!taken.count) throw new ConflictException(`This report was already ${claim.status.toLowerCase()}`);
    await this.prisma.notification.create({
      data: {
        businessId: claim.businessId,
        userId: claim.submittedById,
        title: 'Payment not confirmed',
        body: `${text} Check the details and report it again from the Subscription page, or contact us.`.slice(0, 1000),
        link: '/subscription',
      },
    });
    this.realtime.emit({ businessId: claim.businessId, topics: ['notifications', 'subscription'] });
    this.realtime.emitAdmin(['claims']);
    await this.audit.record(actor, 'payment.claim.reject', {
      businessId: claim.businessId,
      details: { claimId: id, reason: text },
    });
    return { claimId: id, rejected: true };
  }

  private async findOrThrow(id: string) {
    const claim = await this.prisma.paymentClaim.findUnique({ where: { id } });
    if (!claim) throw new NotFoundException('Payment report not found');
    return claim;
  }
}
