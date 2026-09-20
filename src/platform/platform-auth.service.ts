import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from '../common/email';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { ChangePasswordDto } from './dto/platform.dto';

@Injectable()
export class PlatformAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: PlatformAuditService,
  ) {}

  async login(rawEmail: string, password: string, ip: string | null) {
    const email = normalizeEmail(rawEmail);
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { email },
    });
    const ok =
      !!admin && admin.isActive && (await argon2.verify(admin.passwordHash, password));
    if (!admin || !ok) {
      await this.audit.record({ adminId: admin?.id ?? null, email, ip }, 'admin.login-failed');
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.audit.record({ adminId: admin.id, email, ip }, 'admin.login');
    return {
      accessToken: this.sign(admin.id),
      admin: { id: admin.id, email: admin.email, name: admin.name },
    };
  }

  /**
   * Change the signed-in admin's password. Every earlier token stops working
   * (the strategy checks passwordChangedAt), so a fresh one is returned to
   * keep this session signed in.
   */
  async changePassword(actor: Actor, dto: ChangePasswordDto) {
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: actor.adminId! },
    });
    if (!admin) throw new UnauthorizedException();
    if (!(await argon2.verify(admin.passwordHash, dto.currentPassword))) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: {
        passwordHash: await argon2.hash(dto.newPassword),
        passwordChangedAt: new Date(),
      },
    });
    await this.audit.record(actor, 'admin.change-password');
    return { message: 'Password changed.', accessToken: this.sign(admin.id) };
  }

  private sign(adminId: string) {
    return this.jwt.sign({ sub: adminId, scope: 'platform' });
  }
}
