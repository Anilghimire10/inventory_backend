import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from './types/auth-user';

/**
 * The store a request should be confined to, or undefined for a caller who may
 * see the whole business.
 *
 * StoreScopeGuard already refuses a pinned user who *names* another store, so
 * this covers the other half: a list or report asked for with no store at all.
 * Without it a cashier assigned to one branch still saw every branch's rows
 * simply by not filtering -- the guard has nothing to compare against when the
 * field is absent.
 */
export function scopeToStore(
  user: AuthUser,
  requested?: string,
): string | undefined {
  if (user.role === UserRole.OWNER || user.role === UserRole.MANAGER) {
    return requested || undefined;
  }
  // '' is the UI's "all stores"; for pinned staff that still means their own.
  return user.storeId ?? (requested || undefined);
}

/**
 * Refuse a pinned staff member acting on a record that belongs to another
 * store.
 *
 * StoreScopeGuard checks the store ids a request *names*; a route that acts
 * on an existing record by its id names none, so the guard has nothing to
 * compare. Without this, a cashier assigned to one branch could return a sale
 * rung up at another -- putting stock back on a shelf they don't stand at and
 * paying out a refund no till there would ever account for. Same exemptions
 * as the guard: owners and managers, and staff with no store assigned.
 */
export function assertOwnStore(user: AuthUser, storeId: string) {
  if (user.role === UserRole.OWNER || user.role === UserRole.MANAGER) return;
  if (user.storeId && user.storeId !== storeId) {
    throw new ForbiddenException('You can only work on the store you are assigned to');
  }
}
