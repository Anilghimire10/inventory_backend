import { Prisma } from '@prisma/client';

/**
 * Takes a store's till lock until the transaction ends. Opening a shift,
 * taking a counter out of use and assigning a cashier to one all hold it, so
 * none of them can slip between another's checks and its write. One helper,
 * so the key can never drift between them -- a typo would silently stop them
 * serialising.
 */
export function lockStoreTills(tx: Prisma.TransactionClient, storeId: string) {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shift-open:${storeId}`}))`;
}
