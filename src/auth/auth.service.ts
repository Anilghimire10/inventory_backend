import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BusinessType, EmailTokenType, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { isSubscriptionActive } from '../common/subscription';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/password.dto';
import { TX_OPTS } from '../common/prisma-tx';
import { AuthUser } from '../common/types/auth-user';
import { normalizeEmail } from '../common/email';

const CODE_TTL_MS = 15 * 60 * 1000; // verify/reset codes live 15 minutes

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private mail: MailService,
    private audit: AuditService,
  ) {}

  /**
   * Sign up a brand-new business. Creates, in one transaction:
   *  - the Business (tenant)
   *  - a default "Main Store"
   *  - the first user as OWNER (unverified)
   * Then emails a verification code. Login is blocked until the email is verified.
   */
  async register(dto: RegisterDto) {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');

    const passwordHash = await argon2.hash(dto.password);

    const result = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: dto.businessName,
          type: dto.businessType ?? BusinessType.OTHER,
          ...(dto.salesModel ? { salesModel: dto.salesModel } : {}),
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
          email,
          name: dto.name,
          passwordHash,
          role: UserRole.OWNER,
        },
      });
      return { business, user };
    }, TX_OPTS);

    const code = await this.issueCode(
      result.user.id,
      EmailTokenType.EMAIL_VERIFY,
    );
    // The account is already committed above -- a mail outage must not turn
    // this into a 500 that strands an unverifiable, unretryable account.
    // The user can always hit "resend code" once mail is working again.
    await this.sendMailBestEffort(() =>
      this.mail.sendVerificationCode(email, dto.name, code),
    );

    return {
      message: 'Account created. Check your email for a verification code.',
      email,
    };
  }

  /**
   * Fire a transactional email without letting a delivery failure become an
   * unhandled 500 in the caller -- log it and move on. Used anywhere the
   * surrounding side effect (account creation, code issuance) has already
   * happened and can't be un-done by an email provider being down.
   */
  private async sendMailBestEffort(send: () => Promise<unknown>) {
    try {
      await send();
    } catch (err) {
      this.logger.error('Failed to send email', err as Error);
    }
  }

  /** Confirm the emailed code, mark the account verified, and log the user in. */
  async verifyEmail(rawEmail: string, code: string) {
    const email = normalizeEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new BadRequestException('Invalid or expired code');

    if (!user.emailVerified) {
      const ok = await this.consumeCode(
        user.id,
        EmailTokenType.EMAIL_VERIFY,
        code,
      );
      if (!ok) throw new BadRequestException('Invalid or expired code');
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    return this.issueToken(user.id, user.businessId, user);
  }

  /** Re-send a verification code. Always responds the same way (no enumeration). */
  async resendVerification(rawEmail: string) {
    const email = normalizeEmail(rawEmail);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerified) {
      const code = await this.issueCode(user.id, EmailTokenType.EMAIL_VERIFY);
      // Best-effort: a mail failure must respond identically to the
      // "no such account" branch above, or the endpoint becomes an
      // account-enumeration oracle (200 vs 500 by email existence).
      await this.sendMailBestEffort(() =>
        this.mail.sendVerificationCode(email, user.name, code),
      );
    }
    return { message: 'If that account exists, a new code has been sent.' };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(dto.email) },
      include: {
        business: {
          select: { isSuspended: true, isSubscribed: true, subscribedTo: true },
        },
      },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    if (!user.emailVerified) {
      throw new UnauthorizedException(
        'Please verify your email before signing in.',
      );
    }
    if (user.business.isSuspended) {
      throw new UnauthorizedException(
        'This business has been suspended. Please contact support.',
      );
    }
    if (!isSubscriptionActive(user.business)) {
      throw new UnauthorizedException(
        'Your subscription is inactive. Please renew to continue.',
      );
    }

    void this.audit.record({
      businessId: user.businessId,
      userId: user.id,
      userName: user.name,
      action: 'auth.login',
      entity: 'auth',
      summary: 'Signed in',
    });

    return this.issueToken(user.id, user.businessId, user);
  }

  /** Start a password reset. Always responds the same way (no enumeration). */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && user.isActive) {
      const code = await this.issueCode(user.id, EmailTokenType.PASSWORD_RESET);
      // Best-effort, same enumeration-safety reasoning as resendVerification.
      await this.sendMailBestEffort(() =>
        this.mail.sendPasswordReset(email, user.name, code),
      );
    }
    return {
      message: 'If that account exists, a reset code has been sent.',
    };
  }

  /** Complete a password reset with the emailed code. */
  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(dto.email) },
    });
    if (!user) throw new BadRequestException('Invalid or expired code');

    const ok = await this.consumeCode(
      user.id,
      EmailTokenType.PASSWORD_RESET,
      dto.code,
    );
    if (!ok) throw new BadRequestException('Invalid or expired code');

    const passwordHash = await argon2.hash(dto.password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    return { message: 'Password updated. You can now sign in.' };
  }

  /** Change password for the signed-in user (requires the current password). */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const valid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!valid) throw new BadRequestException('Current password is incorrect');

    const passwordHash = await argon2.hash(dto.newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    return { message: 'Password changed.' };
  }

  /**
   * Sign out the current user. JWTs are stateless, so there is no server-side
   * session to destroy — the client simply discards its token. We record an
   * audit event to mirror `auth.login`.
   */
  async logout(user: AuthUser) {
    void this.audit.record({
      businessId: user.businessId,
      userId: user.userId,
      userName: user.email,
      action: 'auth.logout',
      entity: 'auth',
      summary: 'Signed out',
    });
    return { message: 'Signed out.' };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { business: true, store: true },
    });
    if (!user) throw new UnauthorizedException();
    const { passwordHash, ...safe } = user;

    // Billing/platform-admin fields are deliberately withheld from every
    // role except OWNER/MANAGER, matching the @Roles(OWNER, MANAGER) gate
    // on GET /business -- otherwise this endpoint hands any CASHIER/
    // STOCK_KEEPER the same subscription/suspension data that route
    // withholds from them.
    const canSeeAdminFields =
      user.role === UserRole.OWNER || user.role === UserRole.MANAGER;
    if (!canSeeAdminFields && safe.business) {
      const { isSubscribed, subscribedTo, isSuspended, ...restrictedBusiness } =
        safe.business;
      safe.business = restrictedBusiness as typeof safe.business;
    }

    return safe;
  }

  // ----- One-time code helpers -----

  private hash(code: string) {
    return createHash('sha256').update(code).digest('hex');
  }

  /** Generate a 6-digit code, invalidate prior unused ones, and persist its hash. */
  private async issueCode(userId: string, type: EmailTokenType) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.prisma.emailToken.updateMany({
      where: { userId, type, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await this.prisma.emailToken.create({
      data: {
        userId,
        type,
        codeHash: this.hash(code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    return code;
  }

  /** Validate a code and mark it consumed. Returns false if invalid/expired. */
  private async consumeCode(
    userId: string,
    type: EmailTokenType,
    code: string,
  ) {
    const token = await this.prisma.emailToken.findFirst({
      where: {
        userId,
        type,
        codeHash: this.hash(code),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!token) return false;
    await this.prisma.emailToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    });
    return true;
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
