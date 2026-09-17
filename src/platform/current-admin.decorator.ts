import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { PlatformPrincipal } from './strategies/platform-jwt.strategy';

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PlatformPrincipal =>
    ctx.switchToHttp().getRequest<{ user: PlatformPrincipal }>().user,
);
