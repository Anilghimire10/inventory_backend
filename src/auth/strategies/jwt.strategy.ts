import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { isSubscriptionActive } from '../../common/subscription';
import { PrincipalCache } from '../../common/principal-cache';

export interface JwtPayload {
  sub: string; // userId
  businessId: string;
  /** User.tokenVersion at mint time. Stale values are rejected below. */
  tv?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
    private cache: PrincipalCache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Validated at boot by validateEnv() — never falls back to a literal.
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /** Whatever this returns becomes req.user (typed as AuthUser). */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    // A cache hit is only usable when the token was minted at the version the
    // entry holds. A mismatch is NOT grounds to reject -- the entry may simply
    // be stale, which is exactly what a freshly-minted token looks like right
    // after a password change. Fall through and let the database decide.
    const cached = this.cache.get(payload.sub);
    if (cached && (payload.tv ?? 0) === cached.tokenVersion) {
      return cached.user;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        business: {
          select: { isSuspended: true, isSubscribed: true, subscribedTo: true },
        },
      },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User no longer active');
    }
    // A password change bumps tokenVersion, which retires every token minted
    // before it. Tokens issued prior to this field existing carry no `tv`;
    // those are accepted only while the user is still at version 0.
    if ((payload.tv ?? 0) !== user.tokenVersion) {
      throw new UnauthorizedException(
        'Your password was changed. Please sign in again.',
      );
    }
    if (user.business.isSuspended) {
      throw new UnauthorizedException('This business has been suspended');
    }
    if (!isSubscriptionActive(user.business)) {
      throw new UnauthorizedException(
        'Your subscription is inactive. Please renew to continue.',
      );
    }
    const principal: AuthUser = {
      userId: user.id,
      businessId: user.businessId,
      storeId: user.storeId,
      role: user.role,
      email: user.email,
    };
    this.cache.set(payload.sub, principal, user.tokenVersion);
    return principal;
  }
}
