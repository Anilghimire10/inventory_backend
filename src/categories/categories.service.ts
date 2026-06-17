import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './categories.controller';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async create(businessId: string, dto: CreateCategoryDto) {
    if (dto.parentId) await this.assertOwned(businessId, dto.parentId);
    return this.prisma.category.create({ data: { businessId, ...dto } });
  }

  findAll(businessId: string) {
    return this.prisma.category.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async update(businessId: string, id: string, dto: UpdateCategoryDto) {
    await this.assertOwned(businessId, id);
    if (dto.parentId) {
      if (dto.parentId === id)
        throw new BadRequestException('A category cannot be its own parent');
      await this.assertOwned(businessId, dto.parentId);
    }
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(businessId: string, id: string) {
    await this.assertOwned(businessId, id);
    // The product↔category join rows cascade away on delete; products
    // themselves keep working, just without this category.
    return this.prisma.category.delete({ where: { id } });
  }

  private async assertOwned(businessId: string, id: string) {
    const cat = await this.prisma.category.findFirst({
      where: { id, businessId },
    });
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }
}
