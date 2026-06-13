import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreDto, UpdateStoreDto } from './dto/store.dto';

@Injectable()
export class StoresService {
  constructor(private prisma: PrismaService) {}

  create(businessId: string, dto: CreateStoreDto) {
    return this.prisma.store.create({ data: { businessId, ...dto } });
  }

  findAll(businessId: string) {
    return this.prisma.store.findMany({
      where: { businessId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(businessId: string, id: string) {
    const store = await this.prisma.store.findFirst({
      where: { id, businessId },
    });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async update(businessId: string, id: string, dto: UpdateStoreDto) {
    await this.findOne(businessId, id);
    return this.prisma.store.update({ where: { id }, data: dto });
  }

  async remove(businessId: string, id: string) {
    await this.findOne(businessId, id);
    return this.prisma.store.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
