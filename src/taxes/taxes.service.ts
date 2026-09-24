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

  // Clearing the old default and writing the new one share a transaction:
  // done separately, a create that then failed (a duplicate name, say) had
  // already cleared the default, leaving the business with none.
  async create(businessId: string, dto: CreateTaxDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault) await this.clearDefault(businessId, tx);
        return tx.tax.create({
        data: {
          businessId,
          name: dto.name.trim(),
          rate: dto.rate,
          isActive: dto.isActive ?? true,
          isDefault: dto.isDefault ?? false,
        },
        });
      });
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  async update(businessId: string, id: string, dto: UpdateTaxDto) {
    await this.ensure(businessId, id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.isDefault) await this.clearDefault(businessId, tx);
        return tx.tax.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          rate: dto.rate,
          isActive: dto.isActive,
          isDefault: dto.isDefault,
        },
        });
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

  private clearDefault(businessId: string, tx: Prisma.TransactionClient) {
    return tx.tax.updateMany({
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
