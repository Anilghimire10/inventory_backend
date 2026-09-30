import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { PlatformPrincipal } from './strategies/platform-jwt.strategy';
import { Actor } from './platform-audit.service';

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlatformPrincipal =>
    ctx.switchToHttp().getRequest<{ user: PlatformPrincipal }>().user,
);

/** The signed-in admin plus the request IP, for the platform audit log. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor => {
    const req = ctx.switchToHttp().getRequest<{ user: PlatformPrincipal; ip?: string }>();
    const admin = req.user;
    return { adminId: admin.adminId, email: admin.email, ip: req.ip ?? null, sessionId: admin.sessionId };
  },
);
