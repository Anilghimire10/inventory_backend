import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    const [data, total] = await this.prisma.$transaction([
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
