import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthUser } from '../types/auth-user';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * "View as owner" sessions can look but not touch. Enforced here, on the
 * server, for every route at once -- hiding buttons in the shop app would
 * leave the API itself writable to anyone holding the token.
 *
 * Runs after JwtAuthGuard (registration order in AppModule), so req.user is
 * set on authenticated routes; public ones never carry an impersonation.
 */
@Injectable()
export class ImpersonationReadOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ method: string; user?: AuthUser }>();
    if (!req.user?.impersonatedBy || SAFE_METHODS.has(req.method)) return true;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      code: 'READ_ONLY',
      message: "Read-only: you're viewing this shop from the admin panel, so nothing can be changed.",
    });
  }
}
