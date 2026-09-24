import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStoreDto, UpdateStoreDto } from './dto/store.dto';
import { TX_OPTS } from '../common/prisma-tx';

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
    // One transaction: a half-applied create leaves a branch that exists but
    // carries nothing, and the only repair is re-adding every product by hand
    // through setStores. The seed is part of opening the branch, not a
    // follow-up to it.
    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.create({
        data: { businessId, ...dto },
      });
      const products = await tx.product.findMany({
        where: { businessId },
        select: { id: true },
      });
      if (products.length) {
        await tx.stockItem.createMany({
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
    }, TX_OPTS);
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
    const store = await this.findOne(businessId, id);
    if (dto.isActive === false && store.isActive) {
      await this.assertAnotherActive(businessId, id);
    }
    return this.prisma.store.update({ where: { id }, data: dto });
  }

  async remove(businessId: string, id: string) {
    const store = await this.findOne(businessId, id);
    if (store.isActive) await this.assertAnotherActive(businessId, id);
    return this.prisma.store.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * A business with no active store cannot sell, receive stock or open a
   * till, and nothing in the app can put it right again. Only the web UI
   * guarded this, so a direct API call could leave a shop dead in the water.
   */
  private async assertAnotherActive(businessId: string, id: string) {
    const others = await this.prisma.store.count({
      where: { businessId, isActive: true, id: { not: id } },
    });
    if (others === 0) {
      throw new BadRequestException(
        'This is the only active store — open another before closing it',
      );
    }
  }
}
