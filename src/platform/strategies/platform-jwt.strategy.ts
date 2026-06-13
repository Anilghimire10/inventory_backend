import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

export interface PlatformJwtPayload {
  sub: string; // platform admin id
  scope: 'platform';
}

export interface PlatformPrincipal {
  adminId: string;
  email: string;
  name: string;
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
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'dev-secret',
    });
  }

  async validate(payload: PlatformJwtPayload): Promise<PlatformPrincipal> {
    if (payload.scope !== 'platform') {
      throw new UnauthorizedException();
    }
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: payload.sub },
    });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Admin no longer active');
    }
    return { adminId: admin.id, email: admin.email, name: admin.name };
  }
}
