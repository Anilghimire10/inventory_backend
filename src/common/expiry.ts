const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead counts as "expiring soon": the Expiring tab, alerts, badges. */
export const EXPIRY_SOON_DAYS = 30;

/**
 * An expiry date is the last day stock may be sold, so it counts as expired
 * once that whole day is over. Dates are stored as midnight UTC of the day
 * picked ("2026-10-01"), so the day ends 24 hours after the stored value.
 */
export function isExpired(expiry: Date | null | undefined, now = new Date()): boolean {
  return !!expiry && expiry.getTime() + DAY_MS <= now.getTime();
}

/** Expiry dates at or before this are expired -- the `lte` bound for queries. */
export function expiredCutoff(now = new Date()): Date {
  return new Date(now.getTime() - DAY_MS);
}

/** Expiry dates at or before this are expired or expiring soon. */
export function soonCutoff(now = new Date(), days = EXPIRY_SOON_DAYS): Date {
  return new Date(now.getTime() + days * DAY_MS);
}
