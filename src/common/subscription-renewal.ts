import { Prisma } from '@prisma/client';
import { convertedEnd, paymentPeriod } from './subscription';

type PlanLike = { id: string; prices: { months: number; amount: number }[] };

/**
 * Inside a transaction: lock the business row, then work out what a payment
 * covers and the new end date. Two payments recorded at once -- two admins,
 * or an admin while an online payment completes -- would otherwise both renew
 * from the same end date, and one would be lost. With the lock the second
 * waits, then renews from the first's new end.
 *
 * Paying for a different plan converts the days left first (convertedEnd).
 * `convertedFrom` is the end date before that, when it changed.
 */
export async function lockedRenewal(
  tx: Prisma.TransactionClient,
  opts: {
    businessId: string;
    /** Every plan, to find the one the shop is on now. */
    plans: PlanLike[];
    /** The plan paid for; null keeps the shop on its current plan. */
    planId: string | null;
    now: Date;
    months?: number;
    periodFrom?: Date;
    periodTo?: Date;
  },
) {
  const { businessId, plans, planId, now } = opts;
  await tx.$queryRaw`SELECT id FROM "Business" WHERE id = ${businessId} FOR UPDATE`;
  const business = await tx.business.findUniqueOrThrow({
    where: { id: businessId },
    select: { isSubscribed: true, subscribedTo: true, planId: true },
  });
  const find = (id: string | null) => (id ? (plans.find((p) => p.id === id) ?? null) : null);
  const current = business.isSubscribed ? business.subscribedTo : null;
  const currentEnd = convertedEnd({ now, currentEnd: current, fromPlan: find(business.planId), toPlan: find(planId) });
  const period = paymentPeriod({
    now,
    currentEnd,
    months: opts.months,
    periodFrom: opts.periodFrom,
    periodTo: opts.periodTo,
  });
  return {
    ...period,
    previousEnd: business.subscribedTo,
    convertedFrom: current && currentEnd && currentEnd.getTime() !== current.getTime() ? current : null,
  };
}
