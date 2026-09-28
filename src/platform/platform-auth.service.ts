import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
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

/** A session still counts while it hasn't been ended and its token hasn't expired. */
const openSession = (now = new Date()) => ({ revokedAt: null, expiresAt: { gt: now } });

@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: PlatformAuditService,
    private mail: MailService,
  ) {}

  async login(
    rawEmail: string,
    password: string,
    ip: string | null,
    code?: string,
    userAgent?: string | null,
  ) {
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
    await this.alertIfNewDevice(admin, ip, userAgent ?? null);
    const accessToken = await this.openSession(admin.id, ip, userAgent ?? null);
    return {
      accessToken,
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
    return { message: 'Password changed.', accessToken: await this.keepOnlyThisSession(actor) };
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
    return { enabled: true, accessToken: await this.keepOnlyThisSession(actor) };
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

  // ---- Sessions ----

  /**
   * Start a session and sign its token. The session's expiry is read back
   * from the token itself, so the two can never disagree about how long it
   * lasts (PLATFORM_JWT_EXPIRES_IN).
   */
  private async openSession(adminId: string, ip: string | null, userAgent: string | null) {
    const session = await this.prisma.adminSession.create({
      data: { adminId, ip, userAgent: userAgent?.slice(0, 500) ?? null, expiresAt: new Date(Date.now() + 12 * 3600_000) },
    });
    const token = this.jwt.sign({ sub: adminId, scope: 'platform', sid: session.id });
    const exp = this.jwt.decode<{ exp?: number } | null>(token)?.exp;
    if (exp) {
      await this.prisma.adminSession.update({ where: { id: session.id }, data: { expiresAt: new Date(exp * 1000) } });
    }
    return token;
  }

  /**
   * After a password change or turning on two-factor, every other session
   * ends -- the strategy's passwordChangedAt check already refuses their
   * tokens, and closing the rows keeps the sessions list honest. This one
   * carries on with a fresh token for the same session.
   */
  private async keepOnlyThisSession(actor: Actor) {
    const adminId = actor.adminId!;
    await this.prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null, ...(actor.sessionId ? { id: { not: actor.sessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    if (actor.sessionId) {
      const s = await this.prisma.adminSession.findUnique({ where: { id: actor.sessionId } });
      if (s && !s.revokedAt) return this.jwt.sign({ sub: adminId, scope: 'platform', sid: s.id });
    }
    // A pre-session token: start a proper session for it now.
    return this.openSession(adminId, actor.ip ?? null, null);
  }

  /**
   * Email the admin when they sign in from a browser this account hasn't used
   * before -- the one sign that someone else has the password. Not on an
   * account's very first sign-in, and never blocking the sign-in if the email
   * fails.
   */
  private async alertIfNewDevice(admin: { id: string; email: string; name: string }, ip: string | null, userAgent: string | null) {
    if (!userAgent) return;
    const [before, seen] = await Promise.all([
      this.prisma.adminSession.count({ where: { adminId: admin.id } }),
      this.prisma.adminSession.count({ where: { adminId: admin.id, userAgent: userAgent.slice(0, 500) } }),
    ]);
    if (before === 0 || seen > 0) return;
    this.mail
      .sendAdminNewSignIn(admin.email, admin.name, new Date(), ip, describeDevice(userAgent))
      .catch((e: Error) => this.logger.warn(`New sign-in alert to ${admin.email} failed: ${e.message}`));
  }

  /** Sign this session out. */
  async logout(actor: Actor) {
    if (actor.sessionId) {
      await this.prisma.adminSession.updateMany({
        where: { id: actor.sessionId, adminId: actor.adminId!, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await this.audit.record(actor, 'admin.logout');
    return { ok: true };
  }

  /** The signed-in admin's open sessions, newest first, this one flagged. */
  async sessions(actor: Actor) {
    const rows = await this.prisma.adminSession.findMany({
      where: { adminId: actor.adminId!, ...openSession() },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, ip: true, userAgent: true },
    });
    return rows.map((r) => ({
      ...r,
      device: r.userAgent ? describeDevice(r.userAgent) : 'Unknown device',
      current: r.id === actor.sessionId,
    }));
  }

  /** End one of your own sessions. */
  async revokeSession(actor: Actor, id: string) {
    const res = await this.prisma.adminSession.updateMany({
      where: { id, adminId: actor.adminId!, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Session not found');
    await this.audit.record(actor, 'admin.session.revoke', { details: { sessionId: id } });
    return { ok: true };
  }

  /** "Sign out everywhere else": every session of yours but this one. */
  async revokeOtherSessions(actor: Actor) {
    const res = await this.prisma.adminSession.updateMany({
      where: {
        adminId: actor.adminId!,
        revokedAt: null,
        ...(actor.sessionId ? { id: { not: actor.sessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    await this.audit.record(actor, 'admin.session.revoke-others', { details: { ended: res.count } });
    return { ended: res.count };
  }
}

/**
 * "Chrome on macOS" from a user-agent string. Rough on purpose: enough for
 * someone to recognise their own browser in a list or an alert email.
 */
export function describeDevice(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'A browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'an unknown system';
  return `${browser} on ${os}`;
}

