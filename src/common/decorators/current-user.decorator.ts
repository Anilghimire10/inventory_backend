import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../types/auth-user';

/**
 * Injects the authenticated user (incl. businessId) into a handler.
 *   myHandler(@CurrentUser() user: AuthUser) { ... }
 * Pass a key to grab a single field: @CurrentUser('businessId')
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthUser = request.user;
    return data ? user?.[data] : user;
  },
);
