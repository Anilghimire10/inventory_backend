import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreDto, UpdateStoreDto } from './dto/store.dto';

@Injectable()
export class StoresService {
  constructor(private prisma: PrismaService) {}

  /**
   * Open a new branch carrying the business's existing catalog at zero
   * quantity.
   *
   * ProductsService seeds a new *product* into every existing store, but the
   * mirror image was missing: a new *store* inherited nothing, so a branch
   * opened with an empty catalog and every product had to be added back to it
   * one dialog at a time. A StockItem row is what "this store carries this
   * product" means, so seeding them is what makes the branch usable on day
   * one -- quantities still start at zero and are filled by a purchase,
   * transfer or adjustment.
   */
  async create(businessId: string, dto: CreateStoreDto) {
    const store = await this.prisma.store.create({
      data: { businessId, ...dto },
    });
    const products = await this.prisma.product.findMany({
      where: { businessId },
      select: { id: true },
    });
    if (products.length) {
      await this.prisma.stockItem.createMany({
        data: products.map((p) => ({
          businessId,
          storeId: store.id,
          productId: p.id,
          quantity: 0,
        })),
        skipDuplicates: true,
      });
    }
    return store;
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
