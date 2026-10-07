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

/**
 * The order the till sells batches in: soonest expiry first, but batches
 * already past their date behind every in-date (or undated) one. Stable, so
 * callers sort by expiry then age first and this only moves the expired back.
 *
 * One rule for everything that has to agree with it: the sale drawing stock
 * down, the return inferring where an old sale's units came from, and the
 * till pricing clearance stock before it is drawn.
 */
export function inDateFirst<T extends { expiryDate: Date | null }>(
  batches: T[],
  cutoff = expiredCutoff(),
): T[] {
  const expired = (b: T) => Number(!!b.expiryDate && b.expiryDate <= cutoff);
  return batches.sort((a, b) => expired(a) - expired(b));
}
