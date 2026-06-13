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
}
