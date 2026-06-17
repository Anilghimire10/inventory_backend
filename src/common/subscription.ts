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
