import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Mark a route as accessible without authentication (e.g. login/register). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
