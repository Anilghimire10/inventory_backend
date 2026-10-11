import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSupplierDto,
  UpdateSupplierDto,
} from './suppliers.controller';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';

@Injectable()
export class SuppliersService {
  constructor(private prisma: PrismaService) {}

  create(businessId: string, dto: CreateSupplierDto) {
    return this.prisma.supplier.create({ data: { businessId, ...dto } });
  }

  async findAll(businessId: string, q: PaginationDto) {
    const where: Prisma.SupplierWhereInput = {
      businessId,
      isActive: true,
      ...(q.search
        ? { name: { contains: q.search, mode: 'insensitive' } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  async findOne(businessId: string, id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, businessId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  /**
   * A supplier with what the shop has bought from them and still owes them:
   * the details dialog on Suppliers. Cancelled purchases count for neither,
   * and "owed" is the same rule as Credit → Payables (total above paid), so
   * the two screens never disagree about a supplier's balance.
   */
  async details(businessId: string, id: string) {
    const supplier = await this.findOne(businessId, id);
    const live = {
      businessId,
      supplierId: id,
      status: { not: PurchaseStatus.CANCELLED },
    } satisfies Prisma.PurchaseWhereInput;
    const [all, unpaid, recent] = await Promise.all([
      this.prisma.purchase.aggregate({
        where: live,
        _count: true,
        _sum: { total: true, amountPaid: true, refundDue: true },
        _max: { createdAt: true },
      }),
      this.prisma.purchase.aggregate({
        where: { ...live, total: { gt: this.prisma.purchase.fields.amountPaid } },
        _sum: { total: true, amountPaid: true },
      }),
      this.prisma.purchase.findMany({
        where: { businessId, supplierId: id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          reference: true,
          status: true,
          total: true,
          amountPaid: true,
          createdAt: true,
          store: { select: { id: true, name: true } },
        },
      }),
    ]);
    const n = (d: Prisma.Decimal | null) => Number(d ?? 0);
    return {
      ...supplier,
      summary: {
        purchases: all._count,
        totalPurchased: n(all._sum.total),
        totalPaid: n(all._sum.amountPaid),
        outstanding: Math.round((n(unpaid._sum.total) - n(unpaid._sum.amountPaid)) * 100) / 100,
        refundDue: n(all._sum.refundDue),
        lastPurchaseAt: all._max.createdAt,
      },
      recentPurchases: recent.map((p) => ({
        ...p,
        outstanding: Math.round((Number(p.total) - Number(p.amountPaid)) * 100) / 100,
      })),
    };
  }

  async update(businessId: string, id: string, dto: UpdateSupplierDto) {
    await this.findOne(businessId, id);
    return this.prisma.supplier.update({ where: { id }, data: dto });
  }

  async remove(businessId: string, id: string) {
    await this.findOne(businessId, id);
    return this.prisma.supplier.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
