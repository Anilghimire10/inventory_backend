import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';

export interface AuditEntry {
  businessId: string;
  userId?: string | null;
  userName?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  summary?: string | null;
  method?: string | null;
  path?: string | null;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Persist an activity record. Never throws into the caller's flow.
   *
   * `userName` is a snapshot that outlives the user, so it should be their
   * name. A request only carries the token's email, so callers that don't
   * have the name leave it out and it is looked up here -- off the request
   * path, since callers don't await this.
   */
  async record(entry: AuditEntry) {
    try {
      let userName = entry.userName;
      if (!userName && entry.userId) {
        const user = await this.prisma.user.findUnique({
          where: { id: entry.userId },
          select: { name: true },
        });
        userName = user?.name ?? null;
      }
      await this.prisma.auditLog.create({ data: { ...entry, userName } });
    } catch (e) {
      this.logger.warn(`Failed to write audit log: ${(e as Error).message}`);
    }
  }

  async list(
    businessId: string,
    q: PaginationDto,
    filters: { action?: string; userId?: string } = {},
  ) {
    const where: Prisma.AuditLogWhereInput = {
      businessId,
      ...(filters.action
        ? { action: { contains: filters.action, mode: 'insensitive' } }
        : {}),
      ...(filters.userId ? { userId: filters.userId } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }
}
