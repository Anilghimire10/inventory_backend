import { BadRequestException } from '@nestjs/common';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a business's subscription is currently active.
 * Active when it's marked subscribed AND not past its end date
 * (a null end date means no expiry). Payment wiring (Fonepay) comes later;
 * for now a platform super-admin toggles these fields.
 */
export function isSubscriptionActive(business: {
  isSubscribed: boolean;
  subscribedTo: Date | null;
}): boolean {
  if (!business.isSubscribed) return false;
  if (business.subscribedTo && business.subscribedTo.getTime() < Date.now()) {
    return false;
  }
  return true;
}

/** End of a new signup's free trial: `TRIAL_DAYS` from now (env, default 14). */
export function trialEndsAt(from = new Date()): Date {
  const days = Number(process.env.TRIAL_DAYS ?? 14);
  return new Date(from.getTime() + (Number.isFinite(days) ? days : 14) * DAY_MS);
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
