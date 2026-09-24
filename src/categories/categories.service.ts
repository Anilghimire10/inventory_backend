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
    // Forms send "" for "no parent selected" -- treat that the same as
    // omitted rather than letting it hit the FK constraint as a bad id.
    if (dto.parentId === '') dto.parentId = undefined;
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
    if (dto.parentId === '') dto.parentId = undefined;
    if (dto.parentId) {
      if (dto.parentId === id)
        throw new BadRequestException('A category cannot be its own parent');
      await this.assertOwned(businessId, dto.parentId);
      await this.assertNotDescendant(id, dto.parentId);
    }
    return this.prisma.category.update({ where: { id }, data: dto });
  }

  async remove(businessId: string, id: string) {
    await this.assertOwned(businessId, id);
    // The product↔category join rows cascade away on delete; products
    // themselves keep working, just without this category.
    return this.prisma.category.delete({ where: { id } });
  }

  /**
   * Refuse a parent that sits below `id` in the tree. Only "its own parent"
   * was caught before, so A→B then B→A saved a loop, and anything walking
   * the tree upwards from either never finished.
   */
  private async assertNotDescendant(id: string, parentId: string) {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE ancestors AS (
        SELECT id, "parentId" FROM "Category" WHERE id = ${parentId}
        UNION
        SELECT c.id, c."parentId" FROM "Category" c
        JOIN ancestors a ON c.id = a."parentId"
      )
      SELECT id FROM ancestors WHERE id = ${id} LIMIT 1
    `;
    if (rows.length) {
      throw new BadRequestException(
        'A category cannot be moved under one of its own subcategories',
      );
    }
  }

  private async assertOwned(businessId: string, id: string) {
    const cat = await this.prisma.category.findFirst({
      where: { id, businessId },
    });
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }
}
