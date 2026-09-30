import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnlinePaymentStatus, SubscriptionPaymentMethod, UserRole } from '@prisma/client';
import { AuthUser } from '../common/types/auth-user';
import { TX_OPTS } from '../common/prisma-tx';
import { lockedRenewal } from '../common/subscription-renewal';
import { trackCron } from '../common/cron-status';
import { MailService } from '../mail/mail.service';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, planFits, planTooSmall, pricedFor } from '../settings/settings.service';
import { GatewayId, GatewayState, PaymentGateways, connectIpsRef } from './payment-gateways';
import { toReceipt } from './receipt';
import { emailAdminsAboutClaim } from './claim-alerts';

/** Online plans are priced in rupees: the gateways take nothing else. */
const CURRENCY = 'NPR';
const GATEWAY_LABEL: Record<GatewayId, string> = { ESEWA: 'eSewa', KHALTI: 'Khalti', CONNECTIPS: 'connectIPS' };
const MIN = 60_000;
/** A payment still unpaid after this is given up on. */
const GIVE_UP_MS = 24 * 60 * MIN;
/** The return page usually checks first; the job picks up the rest after this. */
const SWEEP_AFTER_MS = 3 * MIN;
const MOBILE_ORIGINS = ['https://localhost', 'capacitor://localhost'];
/** Written to the admin log as who recorded it. */
const ACTOR = { adminId: null, email: 'online payment' };

/**
 * eSewa, Khalti and connectIPS payments from the shop app. The owner picks a plan, is
 * sent to the gateway, and comes back to /payment-return. Nothing the browser
 * brings back is trusted: the payment is recorded only when the gateway's own
 * status API says it is paid, for the amount we asked. The return page asks
 * for that check, and a job every 10 minutes repeats it for anyone who
 * closed the page before getting back.
 */
@Injectable()
export class OnlinePaymentsService {
  private readonly logger = new Logger(OnlinePaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private settings: SettingsService,
    private gateways: PaymentGateways,
    private mail: MailService,
    private audit: PlatformAuditService,
  ) {}

  /** The gateways the Subscription page offers: none unless there's also a plan to pay for. */
  async options() {
    const gateways = this.gateways.available();
    const plans = gateways.length ? await this.settings.plans() : [];
    return { gateways: plans.length ? gateways : [], currency: CURRENCY };
  }

  /**
   * Start a payment. The amount comes from the plan, never the request. For
   * eSewa the browser posts the returned form; for Khalti it goes to the url.
   */
  async start(user: AuthUser, dto: { gateway: GatewayId; planId: string; months: number; returnOrigin: string }) {
    if (!this.gateways.isAvailable(dto.gateway)) {
      throw new BadRequestException(`${GATEWAY_LABEL[dto.gateway]} isn't available right now.`);
    }
    const chosen = await this.settings.plan(dto.planId);
    const price = chosen?.prices.find((p) => p.months === dto.months);
    if (!chosen || !price) throw new BadRequestException('That plan is no longer offered. Reload the page and pick again.');
    const plan = { months: price.months, amount: price.amount };
    const origin = returnOrigin(dto.returnOrigin);
    const [business, me, activeStores] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: user.businessId }, select: { name: true, currency: true } }),
      this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true, email: true } }),
      this.prisma.store.count({ where: { businessId: user.businessId, isActive: true } }),
    ]);
    if (!business) throw new NotFoundException('Business not found');
    if (!planFits(chosen, activeStores)) throw new BadRequestException(planTooSmall(chosen, activeStores));
    // The wallets take rupees only. A shop shown this plan in dollars pays another way.
    if (pricedFor(chosen, business.currency).currency !== CURRENCY) {
      throw new BadRequestException(
        `${GATEWAY_LABEL[dto.gateway]} takes Nepali rupees only. Pay by bank transfer, then tap "I've paid".`,
      );
    }

    const op = await this.prisma.onlinePayment.create({
      data: {
        businessId: user.businessId,
        startedById: user.userId,
        gateway: dto.gateway,
        planId: chosen.id,
        planName: chosen.name,
        months: plan.months,
        amount: plan.amount,
        currency: CURRENCY,
        // connectIPS is sent a short reference of ours rather than the id.
        ...(dto.gateway === 'CONNECTIPS' ? { gatewayRef: connectIpsRef() } : {}),
      },
      select: { id: true, gatewayRef: true },
    });
    // Trailing slash: the mobile build is a static export that needs it.
    const back = `${origin}/payment-return/`;
    const name = `${chosen.name} plan, ${plan.months} month${plan.months === 1 ? '' : 's'}`;
    try {
      if (dto.gateway === 'ESEWA') {
        const form = this.gateways.esewaForm({
          id: op.id,
          amount: plan.amount,
          successUrl: back,
          // eSewa adds nothing to a failure, so the id rides along.
          failureUrl: `${back}?id=${op.id}&cancelled=1`,
        });
        return { id: op.id, kind: 'form' as const, ...form };
      }
      if (dto.gateway === 'CONNECTIPS') {
        // Its success and failure URLs are the ones registered with NCHL,
        // not sent here: /payment-return/ and /payment-return/?cancelled=1.
        const form = this.gateways.connectIpsForm({
          ref: op.gatewayRef!,
          amount: plan.amount,
          remarks: 'Subscription',
          particulars: `${name}, ${business.name}`,
        });
        return { id: op.id, kind: 'form' as const, ...form };
      }
      const k = await this.gateways.khaltiStart({
        id: op.id,
        amount: plan.amount,
        returnUrl: back,
        websiteUrl: origin,
        name: `${name} (${business.name})`.slice(0, 100),
        customer: me ? { name: me.name, email: me.email } : undefined,
      });
      await this.prisma.onlinePayment.update({ where: { id: op.id }, data: { gatewayRef: k.pidx } });
      return { id: op.id, kind: 'redirect' as const, url: k.url };
    } catch (e) {
      await this.prisma.onlinePayment.update({
        where: { id: op.id },
        data: { status: OnlinePaymentStatus.FAILED, failReason: (e as Error).message.slice(0, 300) },
      });
      throw e;
    }
  }

  /**
   * Where a payment stands, asking the gateway if it isn't settled. Public:
   * the return page may have no session (a locked shop), and the id is an
   * unguessable cuid that reveals only the plan and the new end date.
   */
  async check(id: string) {
    // connectIPS comes back with its TXNID, which is our gatewayRef.
    const op = await this.prisma.onlinePayment.findFirst({ where: { OR: [{ id }, { gatewayRef: id }] } });
    if (!op) throw new NotFoundException('No such payment');
    if (op.status === OnlinePaymentStatus.STARTED) await this.settle(op);
    return this.view(op.id);
  }

  private async view(id: string) {
    const op = await this.prisma.onlinePayment.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        status: true,
        gateway: true,
        months: true,
        amount: true,
        currency: true,
        failReason: true,
        business: { select: { subscribedTo: true } },
      },
    });
    const { business, amount, ...rest } = op;
    return {
      ...rest,
      amount: Number(amount),
      paidUntil: op.status === OnlinePaymentStatus.COMPLETED ? business.subscribedTo : null,
    };
  }

  /** Ask the gateway, then record, fail, or leave it waiting. */
  private async settle(op: {
    id: string;
    gateway: SubscriptionPaymentMethod;
    gatewayRef: string | null;
    amount: { toString(): string };
    createdAt: Date;
  }, now = new Date()): Promise<GatewayState['state']> {
    const amount = Number(op.amount);
    let s: GatewayState;
    if (op.gateway === SubscriptionPaymentMethod.ESEWA) {
      s = await this.gateways.esewaStatus(op.id, amount);
    } else if (op.gateway === SubscriptionPaymentMethod.CONNECTIPS && op.gatewayRef) {
      s = await this.gateways.connectIpsStatus(op.gatewayRef, amount);
    } else if (op.gatewayRef) {
      s = await this.gateways.khaltiLookup(op.gatewayRef);
    } else {
      s = { state: 'unknown' }; // never reached Khalti
    }

    const label = GATEWAY_LABEL[op.gateway as GatewayId];
    if (s.state === 'paid') {
      // Paid, but not what we asked: never extend on it. It needs a person.
      if (Math.abs(s.amount - amount) > 0.005) {
        this.logger.error(`Online payment ${op.id}: paid ${s.amount}, expected ${amount}`);
        if (await this.fail(op.id, `Paid ${s.amount} instead of ${amount}; an admin will check it`)) {
          await this.forReview(op.id, {
            amount: s.amount,
            reference: s.transactionId || op.gatewayRef || op.id,
            note: `${label} took ${s.amount} but the plan costs ${amount}. Not recorded automatically: check it, then confirm with the right months or reject.`,
          });
        }
        return 'failed';
      }
      await this.complete(op.id, s.transactionId, now);
      return 'paid';
    }
    if (s.state === 'failed') {
      await this.fail(op.id, s.reason);
      return 'failed';
    }
    if (now.getTime() - op.createdAt.getTime() > GIVE_UP_MS) {
      // Nothing more will be asked of the gateway after this. If it couldn't
      // say either way, the money may have been taken: a person checks.
      const unsure = s.state === 'pending' && s.unsure;
      if ((await this.fail(op.id, unsure ? `${label} couldn't confirm it; an admin will check it` : 'Not completed')) && unsure) {
        await this.forReview(op.id, {
          amount,
          reference: op.gatewayRef || op.id,
          note: `${label} still couldn't say whether this was paid after a day. Check the merchant dashboard, then confirm or reject.`,
        });
      }
      return 'failed';
    }
    return s.state;
  }

  /** Mark it failed if it's still waiting. True if this call did it. */
  private async fail(id: string, reason: string) {
    const res = await this.prisma.onlinePayment.updateMany({
      where: { id, status: OnlinePaymentStatus.STARTED },
      data: { status: OnlinePaymentStatus.FAILED, failReason: reason },
    });
    return res.count > 0;
  }

  /**
   * Money that may have arrived but couldn't be recorded on its own: raise it
   * as a payment report, so it waits on the admin panel's Payments to confirm
   * with the shop's own reports, and email the admins. The owner sees it
   * waiting on their Subscription page too.
   */
  private async forReview(
    id: string,
    what: { amount: number; reference: string; note: string },
  ) {
    try {
      const full = await this.prisma.onlinePayment.findUniqueOrThrow({
        where: { id },
        include: { business: { select: { name: true } } },
      });
      const claim = await this.prisma.paymentClaim.create({
        data: {
          businessId: full.businessId,
          submittedById: full.startedById,
          submittedByName: `${GATEWAY_LABEL[full.gateway as GatewayId]} payment (needs checking)`,
          amount: what.amount,
          currency: full.currency,
          method: full.gateway,
          reference: what.reference.slice(0, 100),
          months: full.months,
          planId: full.planId,
          planName: full.planName,
          note: what.note.slice(0, 500),
        },
      });
      await emailAdminsAboutClaim(this.prisma, this.mail, this.logger, full.business.name, claim);
    } catch (e) {
      this.logger.error(`Online payment ${id} needs checking, but raising it failed: ${(e as Error).message}`);
    }
  }

  /**
   * Record the payment and extend the subscription, once. The return page
   * and the job can both get here for the same payment; the guarded update
   * inside the transaction lets exactly one through.
   */
  private async complete(id: string, transactionId: string, now: Date) {
    const plans = await this.settings.plans();
    const payment = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.onlinePayment.updateMany({
        where: { id, status: OnlinePaymentStatus.STARTED },
        data: { status: OnlinePaymentStatus.COMPLETED, transactionId, completedAt: now },
      });
      if (!claimed.count) return null;
      const op = await tx.onlinePayment.findUniqueOrThrow({ where: { id } });
      // A plan removed since the payment started still moves the shop onto
      // it by id, as before; there's just nothing to convert days against.
      const { from, to, newEnd, previousEnd, convertedFrom } = await lockedRenewal(tx, {
        businessId: op.businessId,
        plans,
        planId: op.planId,
        now,
        months: op.months,
      });
      const p = await tx.subscriptionPayment.create({
        data: {
          businessId: op.businessId,
          amount: op.amount,
          currency: op.currency,
          method: op.gateway,
          reference: transactionId || null,
          periodFrom: from,
          periodTo: to,
          planName: op.planName,
          note: 'Paid online',
        },
      });
      await tx.business.update({
        where: { id: op.businessId },
        // Paying for a plan puts the shop on it.
        data: { isSubscribed: true, subscribedTo: newEnd, ...(op.planId ? { planId: op.planId } : {}) },
      });
      await tx.onlinePayment.update({ where: { id }, data: { paymentId: p.id } });
      return { ...p, previousEnd, convertedFrom };
    }, TX_OPTS);
    if (!payment) return;

    await this.audit.record(ACTOR, 'payment.online', {
      businessId: payment.businessId,
      details: {
        onlinePaymentId: id,
        paymentId: payment.id,
        amount: Number(payment.amount),
        currency: payment.currency,
        method: payment.method,
        transactionId,
        periodFrom: payment.periodFrom.toISOString(),
        periodTo: payment.periodTo.toISOString(),
        previousEnd: payment.previousEnd?.toISOString() ?? null,
        // Days left on the old plan, converted for the new one.
        ...(payment.convertedFrom ? { convertedFrom: payment.convertedFrom.toISOString() } : {}),
      },
    });
    await this.emailReceipt(payment.id);
  }

  /** The receipt to the shop's owners. Best effort: it's on their Subscription page too. */
  private async emailReceipt(paymentId: string) {
    try {
      const p = await this.prisma.subscriptionPayment.findUniqueOrThrow({
        where: { id: paymentId },
        include: { business: { select: { id: true, name: true, taxId: true } } },
      });
      const r = toReceipt(p, await this.settings.get());
      const owners = await this.prisma.user.findMany({
        where: { businessId: p.businessId, role: UserRole.OWNER, isActive: true, emailVerified: true },
        select: { email: true, name: true },
      });
      await Promise.all(
        owners.map((o) =>
          this.mail
            .sendSubscriptionReceipt(o.email, o.name, r)
            .catch((e: Error) => this.logger.warn(`Receipt ${r.receiptNo} to ${o.email} failed: ${e.message}`)),
        ),
      );
    } catch (e) {
      this.logger.warn(`Receipt for online payment ${paymentId} failed: ${(e as Error).message}`);
    }
  }

  /** Every 10 minutes: settle payments whose owner never came back to the return page. */
  @Cron('0 */10 * * * *')
  async sweep(now = new Date()) {
    await trackCron('online-payments', async () => {
      const waiting = await this.prisma.onlinePayment.findMany({
        where: { status: OnlinePaymentStatus.STARTED, createdAt: { lt: new Date(now.getTime() - SWEEP_AFTER_MS) } },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });
      const tally: Record<string, number> = {};
      for (const op of waiting) {
        let state: string;
        try {
          state = await this.settle(op, now);
        } catch (e) {
          this.logger.warn(`Checking online payment ${op.id}: ${(e as Error).message}`);
          state = 'error';
        }
        tally[state] = (tally[state] ?? 0) + 1;
      }
      const parts = Object.entries(tally).map(([k, v]) => `${v} ${k}`);
      return waiting.length ? `Checked ${waiting.length}: ${parts.join(', ')}` : 'Nothing waiting';
    });
  }
}

/**
 * Where the gateway sends the owner back to: the shop app they came from.
 * In production only an allowed origin (SHOP_APP_URL, CORS_ORIGIN, the
 * mobile app); in development any, as CORS does there.
 */
export function returnOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequestException('returnOrigin must be a URL');
  }
  // URL.origin is "null" for capacitor://, so build it.
  const origin = `${u.protocol}//${u.host}`;
  if (!['http:', 'https:', 'capacitor:'].includes(u.protocol)) {
    throw new BadRequestException('returnOrigin must be the shop app');
  }
  if (process.env.NODE_ENV !== 'production') return origin;
  const allowed = new Set(MOBILE_ORIGINS);
  for (const v of [process.env.SHOP_APP_URL, ...(process.env.CORS_ORIGIN ?? '').split(',')]) {
    try {
      if (v?.trim()) allowed.add(new URL(v.trim()).origin);
    } catch {
      /* not a URL: ignore */
    }
  }
  if (!allowed.has(origin)) throw new BadRequestException('returnOrigin must be the shop app');
  return origin;
}
