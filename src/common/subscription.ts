import { BadRequestException, UnauthorizedException } from '@nestjs/common';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days a shop keeps working after its end date (env
 * `SUBSCRIPTION_GRACE_DAYS`, default 3). A renewal that is a day late --
 * a bank transfer still clearing, an owner who was travelling -- shouldn't
 * lock the till mid-shift. The end date itself doesn't move: the admin panel
 * still shows the business as expired, and a payment still renews from it.
 */
export function graceDays(): number {
  const days = Number(process.env.SUBSCRIPTION_GRACE_DAYS ?? 3);
  return Number.isFinite(days) && days >= 0 ? days : 3;
}

/** When the app actually stops working: the end date plus the grace period. */
export function accessEndsAt(subscribedTo: Date): Date {
  return new Date(subscribedTo.getTime() + graceDays() * DAY_MS);
}

/**
 * Whether a business may use the app right now: switched on, and not past
 * its end date plus the grace period (a null end date means no expiry).
 */
export function isSubscriptionActive(
  business: { isSubscribed: boolean; subscribedTo: Date | null },
  now = new Date(),
): boolean {
  if (!business.isSubscribed) return false;
  if (business.subscribedTo && accessEndsAt(business.subscribedTo) <= now) {
    return false;
  }
  return true;
}

/** Who a locked-out shop should contact to renew (env; either may be unset). */
export function supportContact(): { email?: string; phone?: string } {
  const email = process.env.SUPPORT_EMAIL?.trim();
  const phone = process.env.SUPPORT_PHONE?.trim();
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
}

/**
 * The 401 a shop gets once its subscription stops it. Still a 401, so an
 * older app build keeps treating it as "signed out" and shows the message;
 * `code` is what lets a current build show the expired screen instead of
 * bouncing to login, with the date and who to call.
 */
export class SubscriptionInactiveException extends UnauthorizedException {
  constructor(business: { isSubscribed: boolean; subscribedTo: Date | null }) {
    const expired = business.isSubscribed && !!business.subscribedTo;
    super({
      statusCode: 401,
      error: 'Unauthorized',
      code: 'SUBSCRIPTION_INACTIVE',
      message: 'Your subscription is inactive. Please renew to continue.',
      reason: expired ? 'expired' : 'inactive',
      endedAt: expired ? business.subscribedTo!.toISOString() : null,
      contact: supportContact(),
    });
  }
}

/**
 * What the shop app shows its owner about the subscription. Only states that
 * call for a banner are distinguished; everything else is `active`.
 *
 * - `trial`: has an end date and has never paid.
 * - `ending`: paid, and the end date is within 7 days.
 * - `grace`: past the end date but inside the grace period, still working.
 */
export function subscriptionSummary(
  business: { isSubscribed: boolean; subscribedTo: Date | null },
  paymentCount: number,
  now = new Date(),
) {
  const end = business.subscribedTo;
  if (!business.isSubscribed || !end) {
    return { status: 'active' as const, endsAt: null, accessEndsAt: null, daysLeft: null };
  }
  const accessEnd = accessEndsAt(end);
  const base = { endsAt: end.toISOString(), accessEndsAt: accessEnd.toISOString() };
  if (end <= now) {
    return { status: 'grace' as const, ...base, daysLeft: daysUntil(accessEnd, now), contact: supportContact() };
  }
  const daysLeft = daysUntil(end, now);
  if (paymentCount === 0) return { status: 'trial' as const, ...base, daysLeft, contact: supportContact() };
  if (daysLeft <= 7) return { status: 'ending' as const, ...base, daysLeft, contact: supportContact() };
  return { status: 'active' as const, ...base, daysLeft };
}

/**
 * End of a new signup's free trial, `days` from now. The length comes from
 * `SettingsService.trialDays()` (the admin panel's setting, else env
 * `TRIAL_DAYS`, else 14).
 */
export function trialEndsAt(days: number, from = new Date()): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

export type SubscriptionStatus =
  | 'inactive' // switched off by an admin
  | 'expired' // past its end date
  | 'trial' // has an end date and has never paid
  | 'expiring' // paid, ending within `soonDays`
  | 'active'; // paid with time to spare, or no end date at all

/**
 * One label per business for the admin panel. The order matters: a trial
 * ending tomorrow is a trial, not "expiring" -- expiring means a paying
 * customer is about to lapse.
 */
export function subscriptionStatus(
  business: { isSubscribed: boolean; subscribedTo: Date | null },
  paymentCount: number,
  now = new Date(),
  soonDays = 7,
): SubscriptionStatus {
  const end = business.subscribedTo?.getTime();
  if (!business.isSubscribed) return 'inactive';
  if (end !== undefined && end < now.getTime()) return 'expired';
  if (end !== undefined && paymentCount === 0) return 'trial';
  if (end !== undefined && end - now.getTime() <= soonDays * DAY_MS) return 'expiring';
  return 'active';
}

/** Add calendar months in UTC, clamping to the month's end (Jan 31 + 1 = Feb 28/29). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * The period a payment covers and the business's new end date.
 *
 * A renewal starts where the current subscription ends if that is still in
 * the future, so paying early never loses days. The end date never moves
 * backwards: recording an old payment can't shorten a longer subscription.
 * `currentEnd` should be null for a switched-off subscription.
 */
export function paymentPeriod(opts: {
  now: Date;
  currentEnd: Date | null;
  months?: number;
  periodFrom?: Date;
  periodTo?: Date;
}): { from: Date; to: Date; newEnd: Date } {
  const { now, currentEnd, months, periodTo } = opts;
  if ((months === undefined) === (periodTo === undefined)) {
    throw new BadRequestException('Give either months or periodTo, not both');
  }
  const from = opts.periodFrom ?? (currentEnd && currentEnd > now ? currentEnd : now);
  const to = months !== undefined ? addMonths(from, months) : periodTo!;
  if (to <= from) {
    throw new BadRequestException('The period must end after it starts');
  }
  const newEnd = currentEnd && currentEnd > to ? currentEnd : to;
  return { from, to, newEnd };
}

/**
 * Whole days until `end`, rounded up: 6.4 days left reads as 7, and anything
 * from just expired to a day past reads as 0. Run once a day, this hits each
 * reminder threshold exactly once.
 */
export function daysUntil(end: Date, now = new Date()): number {
  const days = Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
  return days === 0 ? 0 : days; // normalise -0
}
