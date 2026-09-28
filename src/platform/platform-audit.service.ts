import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { paginate } from '../common/dto/pagination.dto';
import { QueryAuditLogDto, createdBetween } from './dto/platform.dto';

/** Who did something in the admin panel, and from where. */
export interface Actor {
  /** Null for a failed login, where nobody has authenticated yet. */
  adminId: string | null;
  email: string;
  ip?: string | null;
}

/** The admin-side audit trail: suspensions, payments, resets, logins. */
@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);

  constructor(private prisma: PrismaService) {}

  /** Record an admin action. Never throws into the caller's flow. */
  async record(
    actor: Actor,
    action: string,
    target: {
      businessId?: string;
      targetUserId?: string;
      details?: Prisma.InputJsonValue;
    } = {},
  ) {
    try {
      await this.prisma.platformAuditLog.create({
        data: {
          adminId: actor.adminId,
          adminEmail: actor.email,
          ip: actor.ip ?? null,
          action,
          businessId: target.businessId ?? null,
          targetUserId: target.targetUserId ?? null,
          details: target.details,
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to write platform audit log: ${(e as Error).message}`);
    }
  }

  async list(q: QueryAuditLogDto) {
    const where: Prisma.PlatformAuditLogWhereInput = {
      ...(q.adminId ? { adminId: q.adminId } : {}),
      ...(q.businessId ? { businessId: q.businessId } : {}),
      ...(q.search ? { action: { contains: q.search, mode: 'insensitive' } } : {}),
      ...createdBetween(q),
    };
    const [data, total] = await Promise.all([
      this.prisma.platformAuditLog.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          admin: { select: { id: true, name: true, email: true } },
          business: { select: { id: true, name: true } },
        },
      }),
      this.prisma.platformAuditLog.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }
}
