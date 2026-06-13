import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  async create(businessId: string, dto: CreateProductDto) {
    if (dto.categoryId) await this.assertCategory(businessId, dto.categoryId);
    try {
      return await this.prisma.product.create({
        data: { businessId, ...dto },
      });
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  async findAll(businessId: string, q: QueryProductDto) {
    const where: Prisma.ProductWhereInput = {
      businessId,
      ...(q.activeOnly !== false ? { isActive: true } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { sku: { contains: q.search, mode: 'insensitive' } },
              { barcode: { contains: q.search, mode: 'insensitive' } },
              { brand: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { name: 'asc' },
        include: { category: { select: { id: true, name: true } } },
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  async findOne(businessId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, businessId },
      include: {
        category: { select: { id: true, name: true } },
        stockItems: { select: { storeId: true, quantity: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /** Quick lookup for the POS: scan a barcode -> product. */
  async findByBarcode(businessId: string, barcode: string) {
    const product = await this.prisma.product.findFirst({
      where: { businessId, barcode, isActive: true },
    });
    if (!product) throw new NotFoundException('No product with that barcode');
    return product;
  }

  async update(businessId: string, id: string, dto: UpdateProductDto) {
    await this.findOne(businessId, id);
    if (dto.categoryId) await this.assertCategory(businessId, dto.categoryId);
    try {
      return await this.prisma.product.update({ where: { id }, data: dto });
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  async remove(businessId: string, id: string) {
    await this.findOne(businessId, id);
    // Soft delete keeps sales/purchase history intact.
    return this.prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
  }

  private async assertCategory(businessId: string, categoryId: string) {
    const cat = await this.prisma.category.findFirst({
      where: { id: categoryId, businessId },
    });
    if (!cat) throw new BadRequestException('Invalid category');
  }

  private handleUnique(e: unknown) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | undefined)?.join(', ');
      return new ConflictException(
        `A product with this ${target?.includes('barcode') ? 'barcode' : 'SKU'} already exists`,
      );
    }
    return e as Error;
  }
}
