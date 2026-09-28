import { ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PlatformRole } from '@prisma/client';
import { PlatformPrincipal } from './strategies/platform-jwt.strategy';

const SUPPORT_MAY_WRITE = 'platformSupportMayWrite';
const ADMIN_ONLY = 'platformAdminOnly';

/**
 * A write a SUPPORT admin may make anyway: their own account, "view as
 * owner" (which is itself read-only), and answering support tickets.
 */
export const SupportMayWrite = () => SetMetadata(SUPPORT_MAY_WRITE, true);

const WITHOUT_TWO_FACTOR = 'platform:withoutTwoFactor';
/**
 * Reachable by an admin who still has to set up two-factor while the
 * platform requires it: who am I, set it up, change my password, sign out.
 * Everything else is refused until they have.
 */
export const AllowWithoutTwoFactor = () => SetMetadata(WITHOUT_TWO_FACTOR, true);

/** A read SUPPORT may not make, e.g. downloading a whole business's data. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether an admin with `role` may make this request. See the guard below. */
export function platformRoleAllows(
  role: PlatformRole,
  method: string,
  route: { supportMayWrite?: boolean; adminOnly?: boolean },
): boolean {
  if (role !== PlatformRole.SUPPORT) return true;
  if (route.adminOnly) return false;
  return SAFE_METHODS.has(method) || !!route.supportMayWrite;
}

/**
 * Requires a valid platform (super-admin) JWT, then applies the admin's role.
 *
 * ADMIN can do everything. SUPPORT is read-only by default: every write is
 * refused here, on the server, unless its handler is marked
 * `@SupportMayWrite()` -- so a new endpoint is closed to support until
 * someone decides otherwise, rather than open until someone remembers.
 */
@Injectable()
export class PlatformAuthGuard extends AuthGuard('platform-jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!(await super.canActivate(ctx))) return false;
    const req = ctx.switchToHttp().getRequest<{ method: string; user: PlatformPrincipal }>();
    const flag = (key: string) =>
      this.reflector.getAllAndOverride<boolean>(key, [ctx.getHandler(), ctx.getClass()]);
    if (req.user.twoFactorRequired && !flag(WITHOUT_TWO_FACTOR)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'TWOFA_REQUIRED',
        message: 'Two-factor sign-in is required for admins. Set it up on your Account page first.',
      });
    }
    const allowed = platformRoleAllows(req.user.role, req.method, {
      supportMayWrite: flag(SUPPORT_MAY_WRITE),
      adminOnly: flag(ADMIN_ONLY),
    });
    if (allowed) return true;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'SUPPORT_READ_ONLY',
      message: 'Support accounts can look but not change this. Ask a full admin.',
    });
  }
}
