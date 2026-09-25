import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from '../common/email';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { ChangePasswordDto, DisableTwoFactorDto } from './dto/platform.dto';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  otpauthUrl,
  verifyTotp,
} from '../common/totp';

/** Wrong two-factor codes in a row before the account stops taking codes. */
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCK_MS = 15 * 60_000;

type CodeResult = 'ok' | 'wrong' | 'locked';

const LOCKED_MESSAGE = 'Too many wrong codes. Wait 15 minutes, then try again.';

/** What acceptCode needs to know about the admin. */
type TotpState = {
  id: string;
  totpSecret: string;
  totpLastStep: number | null;
  totpLockedUntil: Date | null;
};

@Injectable()
export class PlatformAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: PlatformAuditService,
  ) {}

  async login(rawEmail: string, password: string, ip: string | null, code?: string) {
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

    // Two-factor is asked for only after the password is right, so a guessed
    // password is what reveals that an account has it -- never an email alone.
    if (admin.totpEnabledAt && admin.totpSecret) {
      if (!code?.trim()) {
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Unauthorized',
          code: 'TOTP_REQUIRED',
          message: 'Enter the 6-digit code from your authenticator app.',
        });
      }
      const result = await this.acceptCode({ ...admin, totpSecret: admin.totpSecret }, code);
      if (result !== 'ok') {
        await this.audit.record({ adminId: admin.id, email, ip }, 'admin.login-failed', {
          details: { reason: result === 'locked' ? 'two-factor locked' : 'two-factor code' },
        });
        throw new UnauthorizedException(
          result === 'locked'
            ? {
                statusCode: 401,
                error: 'Unauthorized',
                code: 'TOTP_LOCKED',
                message: LOCKED_MESSAGE,
              }
            : {
                statusCode: 401,
                error: 'Unauthorized',
                code: 'TOTP_INVALID',
                message: 'That code is wrong or has already been used. Try the next one.',
              },
        );
      }
    }

    await this.audit.record({ adminId: admin.id, email, ip }, 'admin.login');
    return {
      accessToken: this.sign(admin.id),
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
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

  // ---- Two-factor (TOTP) ----

  /** Whether the signed-in admin has two-factor on. */
  async twoFactorStatus(adminId: string) {
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: adminId },
      select: { totpEnabledAt: true },
    });
    return { enabled: !!admin?.totpEnabledAt, enabledAt: admin?.totpEnabledAt ?? null };
  }

  /**
   * Start enrolment: a new secret, stored but not yet in force. It only takes
   * effect once `enableTwoFactor` sees a code from it, so scanning the wrong
   * QR code (or none) can't lock anyone out. Starting again replaces it.
   */
  async setupTwoFactor(actor: Actor) {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: actor.adminId! } });
    if (!admin) throw new UnauthorizedException();
    if (admin.totpEnabledAt) throw new ConflictException('Two-factor is already on');
    const secret = generateTotpSecret();
    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { totpSecret: encryptTotpSecret(secret), totpLastStep: null },
    });
    return { secret, otpauthUrl: otpauthUrl(admin.email, secret) };
  }

  /**
   * Confirm enrolment. Every other session ends here, the same way a password
   * change does: whoever else was signed in got there on the password alone,
   * and two-factor is the admin saying that isn't enough. A fresh token keeps
   * this session.
   */
  async enableTwoFactor(actor: Actor, code: string) {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: actor.adminId! } });
    if (!admin) throw new UnauthorizedException();
    if (admin.totpEnabledAt) throw new ConflictException('Two-factor is already on');
    if (!admin.totpSecret) throw new BadRequestException('Start the setup first');
    const result = await this.acceptCode({ ...admin, totpSecret: admin.totpSecret }, code);
    if (result !== 'ok') {
      throw new BadRequestException(
        result === 'locked' ? LOCKED_MESSAGE : 'That code is wrong or has expired. Try the one showing now.',
      );
    }
    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { totpEnabledAt: new Date(), passwordChangedAt: new Date() },
    });
    await this.audit.record(actor, 'admin.2fa.enable');
    return { enabled: true, accessToken: this.sign(admin.id) };
  }

  /** Turn it off yourself: needs the password and a current code. */
  async disableTwoFactor(actor: Actor, dto: DisableTwoFactorDto) {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { id: actor.adminId! } });
    if (!admin) throw new UnauthorizedException();
    if (!admin.totpEnabledAt || !admin.totpSecret) throw new BadRequestException('Two-factor is not on');
    if (!(await argon2.verify(admin.passwordHash, dto.password))) {
      throw new BadRequestException('Password is incorrect');
    }
    const result = await this.acceptCode({ ...admin, totpSecret: admin.totpSecret }, dto.code);
    if (result !== 'ok') {
      throw new BadRequestException(result === 'locked' ? LOCKED_MESSAGE : 'That code is wrong or has expired');
    }
    await this.prisma.platformAdmin.update({
      where: { id: admin.id },
      data: {
        totpSecret: null,
        totpEnabledAt: null,
        totpLastStep: null,
        totpFailedAttempts: 0,
        totpLockedUntil: null,
      },
    });
    await this.audit.record(actor, 'admin.2fa.disable');
    return { enabled: false };
  }

  /**
   * Check a code and spend its step. The update is conditional on the step
   * not having moved past it meanwhile, so two requests racing with the same
   * code can't both get in.
   *
   * Wrong codes are counted per account, not per IP: the throttle alone
   * would let someone holding the password spread guesses across addresses.
   * After TOTP_MAX_FAILURES in a row the account takes no code at all -- not
   * even a right one -- until the lock runs out.
   */
  private async acceptCode(admin: TotpState, code: string): Promise<CodeResult> {
    if (admin.totpLockedUntil && admin.totpLockedUntil > new Date()) return 'locked';
    let secret: string;
    try {
      secret = decryptTotpSecret(admin.totpSecret);
    } catch {
      // Key changed (JWT_SECRET / TOTP_ENCRYPTION_KEY): another admin resets it.
      return 'wrong';
    }
    const step = verifyTotp(secret, code);
    if (step !== null && (admin.totpLastStep === null || step > admin.totpLastStep)) {
      const { count } = await this.prisma.platformAdmin.updateMany({
        where: { id: admin.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
        data: { totpLastStep: step, totpFailedAttempts: 0, totpLockedUntil: null },
      });
      if (count === 1) return 'ok';
    }
    return this.recordWrongCode(admin.id);
  }

  /** Count a wrong code; the one that reaches the limit starts the lock. */
  private async recordWrongCode(adminId: string): Promise<CodeResult> {
    const { totpFailedAttempts } = await this.prisma.platformAdmin.update({
      where: { id: adminId },
      data: { totpFailedAttempts: { increment: 1 } },
      select: { totpFailedAttempts: true },
    });
    if (totpFailedAttempts < TOTP_MAX_FAILURES) return 'wrong';
    await this.prisma.platformAdmin.update({
      where: { id: adminId },
      data: { totpFailedAttempts: 0, totpLockedUntil: new Date(Date.now() + TOTP_LOCK_MS) },
    });
    return 'locked';
  }

  private sign(adminId: string) {
    return this.jwt.sign({ sub: adminId, scope: 'platform' });
  }
}
