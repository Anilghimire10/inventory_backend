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
import { createHash, randomInt } from 'crypto';
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
import { PrincipalCache } from '../common/principal-cache';

const CODE_TTL_MS = 15 * 60 * 1000; // verify/reset codes live 15 minutes
/**
 * Wrong guesses allowed per issued code before it is burned. A 6-digit code
 * is 1-in-a-million per try, so this is what makes guessing it infeasible --
 * the per-IP throttle alone doesn't, since an attacker can spread the
 * attempts across addresses.
 */
const MAX_CODE_ATTEMPTS = 5;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private mail: MailService,
    private audit: AuditService,
    private principals: PrincipalCache,
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
    // Bumping tokenVersion signs out every session that was already running —
    // the whole point of a reset is that whoever else had the old password
    // (or a token minted under it) loses access now, not in seven days.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    // The cached principal still carries the old tokenVersion; leaving it
    // would let the just-retired token keep matching it until the TTL lapsed.
    this.principals.evict(user.id);
    return { message: 'Password updated. You can now sign in.' };
  }

  /** Change password for the signed-in user (requires the current password). */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const valid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!valid) throw new BadRequestException('Current password is incorrect');

    const passwordHash = await argon2.hash(dto.newPassword);
    // Same invalidation as a reset: every other session this user had is now
    // dead. Their *current* one would be too, so hand back a fresh token
    // minted at the new version for the client to swap in.
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    this.principals.evict(userId);
    return {
      message: 'Password changed.',
      ...this.issueToken(updated.id, updated.businessId, updated),
    };
  }

  /**
   * Sign out the current user. JWTs are stateless, so there is no server-side
   * session to destroy — the client simply discards its token. We record an
   * audit event to mirror `auth.login`.
   */
  logout(user: AuthUser) {
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
    // randomInt, not Math.random: this guards password resets, and Math.random
    // is a predictable PRNG that is explicitly not for anything security-bearing.
    const code = String(randomInt(100000, 1000000));
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
    // Outside production, put the code where a developer can actually read it.
    // Only the hash is stored, so with no deliverable mailbox there is
    // otherwise no way to complete a verify/reset flow locally. Guarded hard:
    // logging a live credential on a real deployment is not a trade worth
    // making, and hosted log aggregators keep these lines for a long time.
    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(`[dev] ${type} code for user ${userId}: ${code}`);
    }
    return code;
  }

  /**
   * Validate a code and mark it consumed. Returns false if invalid/expired.
   *
   * The consume is a conditional updateMany rather than a find-then-update:
   * the `consumedAt: null` guard is evaluated against the row's live, locked
   * value at UPDATE time, so two requests racing with the same code produce
   * one winner (count 1) and one loser (count 0) instead of both succeeding.
   *
   * A wrong guess is counted against the outstanding code, and the code is
   * burned once MAX_CODE_ATTEMPTS is reached — otherwise the only limit on
   * guessing 6 digits is a per-IP throttle.
   */
  private async consumeCode(
    userId: string,
    type: EmailTokenType,
    code: string,
  ) {
    const now = new Date();
    const claimed = await this.prisma.emailToken.updateMany({
      where: {
        userId,
        type,
        codeHash: this.hash(code),
        consumedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: MAX_CODE_ATTEMPTS },
      },
      data: { consumedAt: now },
    });
    if (claimed.count > 0) return true;

    // Wrong (or already-spent) code: charge the attempt to whatever live code
    // this user currently holds, so repeated guessing burns it.
    await this.prisma.emailToken.updateMany({
      where: {
        userId,
        type,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  private issueToken(
    userId: string,
    businessId: string,
    user: { email: string; name: string; role: UserRole; tokenVersion: number },
  ) {
    const accessToken = this.jwt.sign({
      sub: userId,
      businessId,
      tv: user.tokenVersion,
    });
    return {
      accessToken,
      user: { id: userId, email: user.email, name: user.name, role: user.role },
    };
  }
}
