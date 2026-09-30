import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_LOCKED_KEY } from '../decorators/allow-locked.decorator';
import type { AuthUser } from '../types/auth-user';

/**
 * Applied globally: every route requires a valid JWT unless decorated @Public().
 * A billing-only pass (a locked shop's) is accepted on @AllowLocked routes
 * only.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const ok = (await super.canActivate(context)) as boolean;
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (ok && user?.billingOnly) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_LOCKED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Unauthorized',
          code: 'SUBSCRIPTION_INACTIVE',
          message: 'Your subscription is inactive. Only paying for it is available until it is renewed.',
        });
      }
    }
    return ok;
  }
}
