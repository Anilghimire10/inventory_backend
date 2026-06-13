import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Requires a valid platform (super-admin) JWT. */
@Injectable()
export class PlatformAuthGuard extends AuthGuard('platform-jwt') {}
