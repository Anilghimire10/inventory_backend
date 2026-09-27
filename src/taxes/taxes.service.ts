import {
  BadRequestException,
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
        // Staff choose a tax for each product, and the product form shows it
        // with the tax's rate -- so that rate is what the product must charge.
        // Products carry a copy of it (Product.taxRate, what a sale reads), and
        // a rate change used to stop here: the form said "VAT (15%)" while the
        // till went on charging 13%. Sales already made keep the rate on their
        // own lines, so history doesn't move.
        if (dto.rate !== undefined) {
          await tx.product.updateMany({
            where: { businessId, taxId: id },
            data: { taxRate: dto.rate },
          });
        }
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

  /**
   * Delete a tax nothing is being sold under.
   *
   * The foreign key only clears Product.taxId, so products used to keep
   * charging the deleted rate while their form showed "No tax" -- the opposite
   * of what staff had chosen, and invisible. Clearing the rate instead would
   * silently change what those products cost. So a tax still on an active
   * product is refused: whoever deletes it moves those products to another
   * tax (or to no tax) first, knowingly. Retired products can't be sold, so
   * they simply let go of it.
   */
  async remove(businessId: string, id: string) {
    await this.ensure(businessId, id);
    const inUse = await this.prisma.product.count({
      where: { businessId, taxId: id, isActive: true },
    });
    if (inUse > 0) {
      throw new BadRequestException(
        `${inUse} product${inUse === 1 ? ' uses' : 's use'} this tax. Choose another tax (or No tax) for ${inUse === 1 ? 'it' : 'them'} first, or deactivate the tax instead.`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { businessId, taxId: id },
        data: { taxId: null, taxRate: 0 },
      });
      return tx.tax.delete({ where: { id } });
    });
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
