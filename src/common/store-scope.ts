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
