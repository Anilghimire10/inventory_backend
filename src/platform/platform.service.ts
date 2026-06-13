import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Cross-tenant operations for the super-admin panel. Unlike every other
 * service, these are deliberately NOT scoped by businessId.
 */
@Injectable()
export class PlatformService {
  constructor(private prisma: PrismaService) {}

  /** Platform-wide totals for the admin dashboard. */
  async stats() {
    const [businesses, suspended, users, products, salesAgg, recent] =
      await Promise.all([
        this.prisma.business.count(),
        this.prisma.business.count({ where: { isSuspended: true } }),
        this.prisma.user.count(),
        this.prisma.product.count(),
        this.prisma.sale.aggregate({
          where: { status: { not: SaleStatus.HELD } },
          _sum: { total: true },
          _count: true,
        }),
        this.prisma.business.findMany({
          take: 5,
          orderBy: { createdAt: 'desc' },
          select: { id: true, name: true, type: true, createdAt: true },
        }),
      ]);

    return {
      businesses,
      activeBusinesses: businesses - suspended,
      suspendedBusinesses: suspended,
      users,
      products,
      totalSalesValue: round2(Number(salesAgg._sum.total ?? 0)),
      totalTransactions: salesAgg._count,
      recentBusinesses: recent,
    };
  }

  /** All businesses with high-level counts. */
  async listBusinesses(q: PaginationDto) {
    const where: Prisma.BusinessWhereInput = q.search
      ? { name: { contains: q.search, mode: 'insensitive' } }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.business.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          type: true,
          currency: true,
          isSuspended: true,
          createdAt: true,
          _count: {
            select: { users: true, products: true, sales: true, stores: true },
          },
        },
      }),
      this.prisma.business.count({ where }),
    ]);
    return paginate(rows, total, q.page, q.limit);
  }

  /** Full detail for one business: profile, users, totals, recent sales. */
  async getBusiness(id: string) {
    const business = await this.prisma.business.findUnique({
      where: { id },
      include: {
        _count: {
          select: { users: true, products: true, sales: true, stores: true, customers: true },
        },
        stores: { select: { id: true, name: true, isActive: true } },
        users: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!business) throw new NotFoundException('Business not found');

    const salesAgg = await this.prisma.sale.aggregate({
      where: { businessId: id, status: { not: SaleStatus.HELD } },
      _sum: { total: true },
      _count: true,
    });
    const recentSales = await this.prisma.sale.findMany({
      where: { businessId: id },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        receiptNo: true,
        total: true,
        status: true,
        createdAt: true,
      },
    });

    return {
      ...business,
      totalSalesValue: round2(Number(salesAgg._sum.total ?? 0)),
      totalTransactions: salesAgg._count,
      recentSales,
    };
  }

  async setSuspended(id: string, isSuspended: boolean) {
    await this.getBusinessOrThrow(id);
    return this.prisma.business.update({
      where: { id },
      data: { isSuspended },
      select: { id: true, name: true, isSuspended: true },
    });
  }

  private async getBusinessOrThrow(id: string) {
    const b = await this.prisma.business.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Business not found');
    return b;
  }
}
