import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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

    const [rows, total] = await Promise.all([
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
          isSubscribed: true,
          subscribedTo: true,
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

  /** Activate/deactivate a business's subscription (until Fonepay is wired). */
  async setSubscription(
    id: string,
    isSubscribed: boolean,
    subscribedTo: string | null,
  ) {
    await this.getBusinessOrThrow(id);
    return this.prisma.business.update({
      where: { id },
      data: {
        isSubscribed,
        subscribedTo: subscribedTo ? new Date(subscribedTo) : null,
      },
      select: { id: true, name: true, isSubscribed: true, subscribedTo: true },
    });
  }

  // ---- Per-business drill-downs (super-admin) ----

  /** Customers of a business, paginated. */
  async businessCustomers(businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { phone: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          creditBalance: true,
          createdAt: true,
          _count: { select: { sales: true } },
        },
      }),
      this.prisma.customer.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  /** Sales history of a business, paginated. */
  async businessSales(businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where: Prisma.SaleWhereInput = {
      businessId,
      ...(q.search
        ? { receiptNo: { contains: q.search, mode: 'insensitive' } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          receiptNo: true,
          total: true,
          status: true,
          paymentMethod: true,
          createdAt: true,
          customer: { select: { name: true } },
          user: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.sale.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  /** A single sale with its line items — "what they sold". */
  async businessSale(businessId: string, saleId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
      include: {
        items: true,
        customer: { select: { name: true } },
        user: { select: { name: true } },
        store: { select: { name: true } },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    return sale;
  }

  /** Global activity feed across every business (super-admin monitoring). */
  async activityFeed(q: PaginationDto) {
    const where: Prisma.AuditLogWhereInput = q.search
      ? { action: { contains: q.search, mode: 'insensitive' } }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          business: { select: { id: true, name: true } },
          user: { select: { name: true, role: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  /** Activity log of a business, paginated. */
  async businessActivity(businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { businessId },
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      }),
      this.prisma.auditLog.count({ where: { businessId } }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  private async getBusinessOrThrow(id: string) {
    const b = await this.prisma.business.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Business not found');
    return b;
  }
}
