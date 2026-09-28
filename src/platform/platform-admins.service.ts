import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRole, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from '../common/email';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { CreateAdminDto, UpdateAdminDto } from './dto/platform.dto';

const ADMIN_SELECT = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  role: true,
  createdAt: true,
  totpEnabledAt: true,
} satisfies Prisma.PlatformAdminSelect;

/**
 * Platform admin accounts. Only full admins get here for writes: SUPPORT is
 * refused by PlatformAuthGuard before these run.
 */
@Injectable()
export class PlatformAdminsService {
  constructor(
    private prisma: PrismaService,
    private audit: PlatformAuditService,
  ) {}

  list() {
    return this.prisma.platformAdmin.findMany({
      select: ADMIN_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(actor: Actor, dto: CreateAdminDto) {
    const email = normalizeEmail(dto.email);
    if (await this.prisma.platformAdmin.findUnique({ where: { email } })) {
      throw new ConflictException('An admin with this email already exists');
    }
    const admin = await this.prisma.platformAdmin.create({
      data: {
        email,
        name: dto.name,
        passwordHash: await argon2.hash(dto.password),
        role: dto.role ?? PlatformRole.ADMIN,
      },
      select: ADMIN_SELECT,
    });
    await this.audit.record(actor, 'admin.create', {
      details: { adminId: admin.id, email, role: admin.role },
    });
    return admin;
  }

  /**
   * Rename, (de)activate, change role or set a new password. The panel can
   * never lock itself out: nobody deactivates or demotes themselves, and at
   * least one active full ADMIN always remains -- a panel with only support
   * accounts left could never create another admin.
   */
  async update(actor: Actor, id: string, dto: UpdateAdminDto) {
    const target = await this.prisma.platformAdmin.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Admin not found');

    // Another admin's, after a lost phone. Your own goes through the Account
    // page, which asks for a code -- this path doesn't, so it isn't for you.
    if (dto.resetTwoFactor && id === actor.adminId) {
      throw new BadRequestException('Turn your own two-factor off from your Account page');
    }

    if (dto.isActive === false && target.isActive) {
      if (id === actor.adminId) {
        throw new BadRequestException('You cannot deactivate yourself');
      }
      const othersActive = await this.prisma.platformAdmin.count({
        where: { isActive: true, id: { not: id } },
      });
      if (othersActive === 0) {
        throw new BadRequestException('At least one admin must stay active');
      }
    }

    if (dto.role !== undefined && dto.role !== target.role && id === actor.adminId) {
      throw new BadRequestException('You cannot change your own role');
    }
    const isFullAdmin = target.isActive && target.role === PlatformRole.ADMIN;
    const staysFullAdmin =
      (dto.isActive ?? target.isActive) && (dto.role ?? target.role) === PlatformRole.ADMIN;
    if (isFullAdmin && !staysFullAdmin) {
      const otherFullAdmins = await this.prisma.platformAdmin.count({
        where: { isActive: true, role: PlatformRole.ADMIN, id: { not: id } },
      });
      if (otherFullAdmins === 0) {
        throw new BadRequestException('At least one active full admin must remain');
      }
    }

    const updated = await this.prisma.platformAdmin.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        // A new password signs the admin out everywhere (see the strategy).
        ...(dto.password
          ? { passwordHash: await argon2.hash(dto.password), passwordChangedAt: new Date() }
          : {}),
        ...(dto.resetTwoFactor
          ? {
              totpSecret: null,
              totpEnabledAt: null,
              totpLastStep: null,
              totpFailedAttempts: 0,
              totpLockedUntil: null,
            }
          : {}),
      },
      select: ADMIN_SELECT,
    });
    await this.audit.record(actor, 'admin.update', {
      details: {
        adminId: id,
        email: target.email,
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        passwordReset: !!dto.password,
        ...(dto.resetTwoFactor ? { twoFactorReset: true } : {}),
      },
    });
    return updated;
  }

  /**
   * End all of an admin's sessions. passwordChangedAt is bumped too, which
   * also retires any token issued before sessions were tracked.
   */
  async signOutEverywhere(actor: Actor, id: string) {
    const target = await this.prisma.platformAdmin.findUnique({ where: { id }, select: { id: true, email: true } });
    if (!target) throw new NotFoundException('Admin not found');
    const now = new Date();
    const [ended] = await this.prisma.$transaction([
      this.prisma.adminSession.updateMany({ where: { adminId: id, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.platformAdmin.update({ where: { id }, data: { passwordChangedAt: now } }),
    ]);
    await this.audit.record(actor, 'admin.sign-out-everywhere', {
      details: { adminId: id, email: target.email, sessions: ended.count },
    });
    return { ended: ended.count };
  }
}
