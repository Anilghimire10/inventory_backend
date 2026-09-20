import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { isSubscriptionActive } from '../../common/subscription';
import { suspendedMessage } from '../auth.service';

export interface JwtPayload {
  sub: string; // userId
  businessId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'dev-secret',
    });
  }

  /** Whatever this returns becomes req.user (typed as AuthUser). */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        business: {
          select: {
            isSuspended: true,
            suspendedReason: true,
            isSubscribed: true,
            subscribedTo: true,
          },
        },
      },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User no longer active');
    }
    if (user.business.isSuspended) {
      throw new UnauthorizedException(suspendedMessage(user.business.suspendedReason));
    }
    if (!isSubscriptionActive(user.business)) {
      throw new UnauthorizedException(
        'Your subscription is inactive. Please renew to continue.',
      );
    }
    return {
      userId: user.id,
      businessId: user.businessId,
      storeId: user.storeId,
      role: user.role,
      email: user.email,
    };
  }
}
