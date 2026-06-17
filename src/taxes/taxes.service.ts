import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaxDto, UpdateTaxDto } from './taxes.controller';

@Injectable()
export class TaxesService {
  constructor(private prisma: PrismaService) {}

  list(businessId: string) {
    return this.prisma.tax.findMany({
      where: { businessId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async create(businessId: string, dto: CreateTaxDto) {
    if (dto.isDefault) await this.clearDefault(businessId);
    try {
      return await this.prisma.tax.create({
        data: {
          businessId,
          name: dto.name.trim(),
          rate: dto.rate,
          isActive: dto.isActive ?? true,
          isDefault: dto.isDefault ?? false,
        },
      });
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  async update(businessId: string, id: string, dto: UpdateTaxDto) {
    await this.ensure(businessId, id);
    if (dto.isDefault) await this.clearDefault(businessId);
    try {
      return await this.prisma.tax.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          rate: dto.rate,
          isActive: dto.isActive,
          isDefault: dto.isDefault,
        },
      });
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  async remove(businessId: string, id: string) {
    await this.ensure(businessId, id);
    // Products referencing this tax keep their snapshotted taxRate; the FK is
    // set null on delete.
    return this.prisma.tax.delete({ where: { id } });
  }

  private clearDefault(businessId: string) {
    return this.prisma.tax.updateMany({
      where: { businessId, isDefault: true },
      data: { isDefault: false },
    });
  }

  private async ensure(businessId: string, id: string) {
    const tax = await this.prisma.tax.findFirst({ where: { id, businessId } });
    if (!tax) throw new NotFoundException('Tax not found');
    return tax;
  }

  private handleUnique(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException('A tax with this name already exists');
    }
    return e as Error;
  }
}
