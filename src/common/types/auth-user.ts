import { UserRole } from '@prisma/client';

/**
 * The authenticated principal attached to every request (req.user).
 * `businessId` is the tenant boundary — services scope all queries to it.
 */
export interface AuthUser {
  userId: string;
  businessId: string;
  storeId: string | null;
  role: UserRole;
  email: string;
  /**
   * Set when a platform admin is viewing the shop as its owner ("view as
   * owner", admin panel). Such a session is read-only: see
   * ImpersonationReadOnlyGuard.
   */
  impersonatedBy?: { adminId: string; email: string; expiresAt: string };
}
