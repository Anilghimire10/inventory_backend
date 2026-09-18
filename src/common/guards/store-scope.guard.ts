import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../types/auth-user';

/** Store fields a request may use to name the store it acts on. */
const STORE_FIELDS = ['storeId', 'fromStoreId', 'toStoreId'] as const;
/** Same, but carrying a list — e.g. the stores that stock a product. */
const STORE_LIST_FIELDS = ['storeIds'] as const;

/**
 * Keeps non-management staff inside the store they are assigned to.
 *
 * `User.storeId` was only ever a *default*: services read it as a fallback
 * (`dto.storeId ?? user.storeId`) and then validated the result against the
 * business, never against the caller. A cashier assigned to one branch could
 * therefore name another branch's store outright -- opening a till there,
 * selling its stock, or reading its numbers -- because every check asked
 * "is this store in your business?" and none asked "is it *yours*?".
 *
 * The rule: a CASHIER or STOCK_KEEPER who has a store assigned may only name
 * that store. Owners and managers are deliberately exempt -- they move between
 * branches, which is what the POS store picker already assumes. Staff with no
 * store assigned are unpinned too, since pinning them to nothing would leave
 * them unable to work at all.
 *
 * Deliberately a rejection and never a rewrite: quietly swapping the store id
 * would make a mis-sent request look like it succeeded against the wrong
 * branch. Defaulting an *omitted* store stays with the services, which know
 * which of their queries a store even applies to.
 */
@Injectable()
export class StoreScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      user?: AuthUser;
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
    }>();

    const user = req.user;
    // Unauthenticated (@Public) routes have no principal to pin.
    if (!user) return true;
    if (user.role === UserRole.OWNER || user.role === UserRole.MANAGER) {
      return true;
    }
    const assigned = user.storeId;
    if (!assigned) return true;

    for (const source of [req.body, req.query]) {
      if (!source || typeof source !== 'object') continue;
      // A transfer names two stores and they must differ, so checking both
      // against the one assigned store would block pinned staff from
      // transferring at all. The two directions are not equivalent: pushing
      // stock *out* of your own branch is safe -- you can only give away what
      // you physically hold, and the movement is stamped with your user id --
      // while pulling *from* another branch would let you drain a shelf you do
      // not stand at. So an outbound transfer may name any destination; the
      // source must still be yours.
      const from = source['fromStoreId'];
      const isOutbound = typeof from === 'string' && from === assigned;

      for (const field of STORE_FIELDS) {
        if (field === 'toStoreId' && isOutbound) continue;
        const value = source[field];
        // Absent, null (an explicit "unassign") and '' (the UI's "all stores")
        // name no store, so there is nothing to compare.
        if (typeof value !== 'string' || value === '') continue;
        if (value !== assigned) {
          throw new ForbiddenException(
            'You can only work on the store you are assigned to',
          );
        }
      }
      for (const field of STORE_LIST_FIELDS) {
        const value = source[field];
        if (!Array.isArray(value)) continue;
        for (const entry of value) {
          if (typeof entry !== 'string' || entry === '') continue;
          if (entry !== assigned) {
            throw new ForbiddenException(
              'You can only work on the store you are assigned to',
            );
          }
        }
      }
    }
    return true;
  }
}
