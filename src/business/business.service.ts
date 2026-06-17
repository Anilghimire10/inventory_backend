import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBusinessDto } from './business.controller';

@Injectable()
export class BusinessService {
  constructor(private prisma: PrismaService) {}

  async get(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) throw new NotFoundException('Business not found');
    return business;
  }

  async update(businessId: string, dto: UpdateBusinessDto) {
    await this.get(businessId);
    return this.prisma.business.update({
      where: { id: businessId },
      data: {
        ...dto,
        ...(dto.currency ? { currency: dto.currency.toUpperCase() } : {}),
      },
    });
  }

  /**
   * Full export of a tenant's data as a JSON snapshot (owner download).
   * Passwords are never included.
   */
  async exportData(businessId: string) {
    const where = { businessId };
    const [
      business,
      stores,
      users,
      categories,
      taxes,
      products,
      suppliers,
      customers,
      purchases,
      sales,
      stockItems,
      stockMovements,
      batches,
    ] = await Promise.all([
      this.get(businessId),
      this.prisma.store.findMany({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true, email: true, name: true, role: true,
          storeId: true, isActive: true, emailVerified: true, createdAt: true,
        },
      }),
      this.prisma.category.findMany({ where }),
      this.prisma.tax.findMany({ where }),
      this.prisma.product.findMany({
        where,
        include: { categories: { select: { id: true, name: true } } },
      }),
      this.prisma.supplier.findMany({ where }),
      this.prisma.customer.findMany({ where }),
      this.prisma.purchase.findMany({ where, include: { items: true } }),
      this.prisma.sale.findMany({ where, include: { items: true } }),
      this.prisma.stockItem.findMany({ where }),
      this.prisma.stockMovement.findMany({ where }),
      this.prisma.batch.findMany({ where }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      business,
      stores,
      users,
      categories,
      taxes,
      products,
      suppliers,
      customers,
      purchases,
      sales,
      stockItems,
      stockMovements,
      batches,
    };
  }
}
