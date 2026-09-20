import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmailTokenType, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuthService } from '../auth/auth.service';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';
import { normalizeEmail } from '../common/email';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { UpdateTenantUserDto } from './dto/platform.dto';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  emailVerified: true,
  createdAt: true,
  business: { select: { id: true, name: true, isSuspended: true } },
  store: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

/**
 * Support tools for shop users across every business ("I can't log in").
 * Unlike the public auth endpoints, mail failures are reported to the admin
 * instead of being swallowed: there is no enumeration risk here, and the
 * admin needs to know whether the email actually went.
 */
@Injectable()
export class PlatformUsersService {
  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private auth: AuthService,
    private audit: PlatformAuditService,
  ) {}

  /** Find users by email or name across all businesses. */
  async search(q: PaginationDto) {
    const where: Prisma.UserWhereInput = q.search
      ? {
          OR: [
            { email: { contains: q.search.trim(), mode: 'insensitive' } },
            { name: { contains: q.search.trim(), mode: 'insensitive' } },
          ],
        }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        select: USER_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  async update(actor: Actor, id: string, dto: UpdateTenantUserDto) {
    const user = await this.getOrThrow(id);
    const data: Prisma.UserUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) {
      const email = normalizeEmail(dto.email);
      if (email !== user.email) {
        const taken = await this.prisma.user.findUnique({ where: { email } });
        if (taken) throw new ConflictException('A user with this email already exists');
        // The new address hasn't been proven to reach this person.
        data.email = email;
        data.emailVerified = false;
      }
    }
    if (dto.isActive !== undefined) {
      if (dto.isActive === false && user.role === UserRole.OWNER && user.isActive) {
        const otherOwners = await this.prisma.user.count({
          where: {
            businessId: user.businessId,
            role: UserRole.OWNER,
            isActive: true,
            id: { not: user.id },
          },
        });
        if (otherOwners === 0) {
          throw new BadRequestException(
            "This is the business's only active owner. Suspend the business instead.",
          );
        }
      }
      data.isActive = dto.isActive;
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: USER_SELECT,
    });
    await this.audit.record(actor, 'user.update', {
      businessId: user.businessId,
      targetUserId: id,
      details: {
        ...(data.name !== undefined ? { name: { from: user.name, to: dto.name } } : {}),
        ...(data.email !== undefined ? { email: { from: user.email, to: data.email as string } } : {}),
        ...(data.isActive !== undefined ? { isActive: { from: user.isActive, to: dto.isActive } } : {}),
      },
    });
    return updated;
  }

  /** Mark the email verified by hand, e.g. when mail delivery is down. */
  async verifyEmail(actor: Actor, id: string) {
    const user = await this.getOrThrow(id);
    if (user.emailVerified) return this.prisma.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { emailVerified: true }, select: USER_SELECT }),
      // Outstanding codes are moot now.
      this.prisma.emailToken.updateMany({
        where: { userId: id, type: EmailTokenType.EMAIL_VERIFY, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    ]);
    await this.audit.record(actor, 'user.verify-email', {
      businessId: user.businessId,
      targetUserId: id,
      details: { email: user.email },
    });
    return updated;
  }

  async resendVerification(actor: Actor, id: string) {
    const user = await this.getOrThrow(id);
    if (user.emailVerified) throw new BadRequestException('This email is already verified');
    const code = await this.auth.issueCode(user.id, EmailTokenType.EMAIL_VERIFY);
    await this.mail.sendVerificationCode(user.email, user.name, code);
    await this.audit.record(actor, 'user.resend-verification', {
      businessId: user.businessId,
      targetUserId: id,
      details: { email: user.email },
    });
    return { message: `Verification code sent to ${user.email}` };
  }

  /** Email the user a reset code; they finish on the app's reset screen. */
  async sendPasswordReset(actor: Actor, id: string) {
    const user = await this.getOrThrow(id);
    if (!user.isActive) {
      throw new BadRequestException('This user is deactivated. Reactivate them first.');
    }
    const code = await this.auth.issueCode(user.id, EmailTokenType.PASSWORD_RESET);
    await this.mail.sendPasswordReset(user.email, user.name, code);
    await this.audit.record(actor, 'user.send-password-reset', {
      businessId: user.businessId,
      targetUserId: id,
      details: { email: user.email },
    });
    return { message: `Password reset code sent to ${user.email}` };
  }

  private async getOrThrow(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
