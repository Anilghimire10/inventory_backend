import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  createdAt: true,
} satisfies Prisma.PlatformAdminSelect;

/** Platform admin accounts. Every admin can manage the others. */
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
      data: { email, name: dto.name, passwordHash: await argon2.hash(dto.password) },
      select: ADMIN_SELECT,
    });
    await this.audit.record(actor, 'admin.create', { details: { adminId: admin.id, email } });
    return admin;
  }

  /**
   * Rename, (de)activate or set a new password. The panel can never lock
   * itself out: nobody deactivates themselves, and the last active admin
   * stays active.
   */
  async update(actor: Actor, id: string, dto: UpdateAdminDto) {
    const target = await this.prisma.platformAdmin.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Admin not found');

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

    const updated = await this.prisma.platformAdmin.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        // A new password signs the admin out everywhere (see the strategy).
        ...(dto.password
          ? { passwordHash: await argon2.hash(dto.password), passwordChangedAt: new Date() }
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
        passwordReset: !!dto.password,
      },
    });
    return updated;
  }
}
