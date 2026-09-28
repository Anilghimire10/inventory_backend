import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PlatformRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { platformJwtSecret } from '../../common/env.validation';

export interface PlatformJwtPayload {
  sub: string; // platform admin id
  scope: 'platform';
  /** AdminSession id. Absent on tokens issued before sessions were tracked. */
  sid?: string;
}

/** How stale lastSeenAt may get before a request refreshes it. */
const LAST_SEEN_EVERY_MS = 5 * 60 * 1000;

export interface PlatformPrincipal {
  adminId: string;
  email: string;
  name: string;
  role: PlatformRole;
  /** The session this request belongs to; null for a pre-session token. */
  sessionId: string | null;
  /** Two-factor is required on the platform and this admin hasn't set it up. */
  twoFactorRequired: boolean;
}

/**
 * Separate strategy ('platform-jwt') for super-admins. Tokens are scoped
 * 'platform' and resolve against PlatformAdmin — completely independent of
 * the tenant ('jwt') strategy, so the two cannot be used interchangeably.
 */
@Injectable()
export class PlatformJwtStrategy extends PassportStrategy(
  Strategy,
  'platform-jwt',
) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
    private settings: SettingsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Must match PlatformModule's signing key; see platformJwtSecret().
      secretOrKey: platformJwtSecret((k) => config.get<string>(k)),
    });
  }

  async validate(payload: PlatformJwtPayload & { iat?: number }): Promise<PlatformPrincipal> {
    if (payload.scope !== 'platform') {
      throw new UnauthorizedException();
    }
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: payload.sub },
    });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Admin no longer active');
    }
    // A password change or reset, or turning on two-factor, signs out every
    // session opened before it.
    // Compared in whole seconds (iat's resolution), so the token issued in
    // the same request as the change still works.
    if (
      admin.passwordChangedAt &&
      (payload.iat ?? 0) < Math.floor(admin.passwordChangedAt.getTime() / 1000)
    ) {
      throw new UnauthorizedException('Your sign-in details changed, please sign in again');
    }
    // A tracked session must still be open: signing out, "sign out everywhere"
    // and an admin ending it from their Account page all close it here,
    // before the token itself would have expired.
    if (payload.sid) {
      const session = await this.prisma.adminSession.findUnique({ where: { id: payload.sid } });
      if (
        !session ||
        session.adminId !== admin.id ||
        session.revokedAt ||
        session.expiresAt.getTime() < Date.now()
      ) {
        throw new UnauthorizedException('This session was signed out, please sign in again');
      }
      if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS) {
        await this.prisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
      }
    }
    const { requireAdminTwoFactor } = await this.settings.get();
    return {
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      sessionId: payload.sid ?? null,
      twoFactorRequired: requireAdminTwoFactor && !admin.totpEnabledAt,
    };
  }
}
