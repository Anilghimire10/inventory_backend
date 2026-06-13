import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BusinessType, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  /**
   * Sign up a brand-new business. Creates, in one transaction:
   *  - the Business (tenant)
   *  - a default "Main Store"
   *  - the first user as OWNER
   */
  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await argon2.hash(dto.password);

    const result = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: dto.businessName,
          type: dto.businessType ?? BusinessType.OTHER,
          ...(dto.currency ? { currency: dto.currency.toUpperCase() } : {}),
        },
      });
      const store = await tx.store.create({
        data: { businessId: business.id, name: 'Main Store' },
      });
      const user = await tx.user.create({
        data: {
          businessId: business.id,
          storeId: store.id,
          email: dto.email,
          name: dto.name,
          passwordHash,
          role: UserRole.OWNER,
        },
      });
      return { business, user };
    });

    return this.issueToken(result.user.id, result.business.id, result.user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { business: { select: { isSuspended: true } } },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (user.business.isSuspended) {
      throw new UnauthorizedException(
        'This business has been suspended. Please contact support.',
      );
    }

    return this.issueToken(user.id, user.businessId, user);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { business: true, store: true },
    });
    if (!user) throw new UnauthorizedException();
    const { passwordHash, ...safe } = user;
    return safe;
  }

  private issueToken(
    userId: string,
    businessId: string,
    user: { email: string; name: string; role: UserRole },
  ) {
    const accessToken = this.jwt.sign({ sub: userId, businessId });
    return {
      accessToken,
      user: { id: userId, email: user.email, name: user.name, role: user.role },
    };
  }
}
