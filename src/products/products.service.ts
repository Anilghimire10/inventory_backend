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
import { GenerateVariantsDto } from './dto/generate-variants.dto';
import { paginate } from '../common/dto/pagination.dto';
import { normalizeUnit } from '../common/units';

const DETAIL_INCLUDE = {
  categories: { select: { id: true, name: true } },
  tax: { select: { id: true, name: true, rate: true } },
} satisfies Prisma.ProductInclude;

type ProductDetail = Prisma.ProductGetPayload<{ include: typeof DETAIL_INCLUDE }>;

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  private readonly detailInclude = DETAIL_INCLUDE;

  async create(businessId: string, dto: CreateProductDto) {
    const { categoryIds, expiryDate, taxId, ...rest } = dto;
    await this.assertCategories(businessId, categoryIds);
    if (dto.parentId) await this.assertParent(businessId, dto.parentId);
    const taxRate = await this.resolveTaxRate(businessId, taxId);
    try {
      const product = await this.prisma.product.create({
        data: {
          businessId,
          ...rest,
          ...(taxId ? { taxId, taxRate } : {}),
          ...(expiryDate ? { expiryDate: new Date(expiryDate) } : {}),
          ...(categoryIds?.length
            ? { categories: { connect: categoryIds.map((id) => ({ id })) } }
            : {}),
        },
        include: this.detailInclude,
      });
      await this.seedStockRows(businessId, product.id);
      return product;
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  /**
   * Give a brand-new product a zero-quantity StockItem in every store so it
   * shows up on the stock page immediately (the stock list reads StockItem
   * rows, not products). Without this it stays invisible until the first
   * purchase/adjustment creates a row.
   */
  private async seedStockRows(businessId: string, productId: string) {
    const stores = await this.prisma.store.findMany({
      where: { businessId },
      select: { id: true },
    });
    if (!stores.length) return;
    await this.prisma.stockItem.createMany({
      data: stores.map((s) => ({
        businessId,
        storeId: s.id,
        productId,
        quantity: 0,
      })),
      skipDuplicates: true,
    });
  }

  async findAll(businessId: string, q: QueryProductDto) {
    const where: Prisma.ProductWhereInput = {
      businessId,
      ...(q.activeOnly !== false ? { isActive: true } : {}),
      ...(q.categoryId ? { categories: { some: { id: q.categoryId } } } : {}),
      ...(q.ids?.length ? { id: { in: q.ids } } : {}),
      ...(q.parentId ? { parentId: q.parentId } : {}),
      ...(q.excludeVariants ? { parentId: null } : {}),
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

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { name: 'asc' },
        include: this.detailInclude,
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  async findOne(businessId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, businessId },
      include: {
        ...this.detailInclude,
        stockItems: { select: { storeId: true, quantity: true } },
        variants: {
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            variantName: true,
            attributes: true,
            sku: true,
            barcode: true,
            sellingPrice: true,
            costPrice: true,
          },
          orderBy: { name: 'asc' },
        },
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
    const { categoryIds, expiryDate, taxId, ...rest } = dto;
    await this.assertCategories(businessId, categoryIds);
    try {
      return await this.prisma.product.update({
        where: { id },
        data: {
          ...rest,
          // Setting a tax snapshots its rate; clearing it (null) leaves the rate.
          ...(taxId !== undefined
            ? taxId
              ? { taxId, taxRate: await this.resolveTaxRate(businessId, taxId) }
              : { taxId: null }
            : {}),
          ...(expiryDate !== undefined
            ? { expiryDate: expiryDate ? new Date(expiryDate) : null }
            : {}),
          // `set` replaces the full category list when the field is provided.
          ...(categoryIds !== undefined
            ? { categories: { set: categoryIds.map((cid) => ({ id: cid })) } }
            : {}),
        },
        include: this.detailInclude,
      });
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  // ---- Variants ----

  /**
   * Create one child product per combination of the supplied options
   * ("Colour: Red, Blue" x "Size: S, M" -> four rows). Each variant is a
   * normal product -- own SKU, price and stock -- so nothing downstream
   * needs to know variants exist. Combinations that already exist under
   * this parent are skipped, so the endpoint is safe to re-run when a new
   * colour is added.
   */
  async generateVariants(
    businessId: string,
    parentId: string,
    dto: GenerateVariantsDto,
  ) {
    const parent = await this.prisma.product.findFirst({
      where: { id: parentId, businessId },
      include: { categories: { select: { id: true } } },
    });
    if (!parent) throw new NotFoundException('Product not found');
    if (parent.parentId) {
      throw new BadRequestException('A variant cannot have variants of its own');
    }

    // Cartesian product of the option values, in the order given.
    const combos = dto.options.reduce<Record<string, string>[]>(
      (acc, opt) =>
        acc.flatMap((row) =>
          opt.values.map((v) => ({ ...row, [opt.name]: v })),
        ),
      [{}],
    );
    if (combos.length > 200) {
      throw new BadRequestException(
        `That would create ${combos.length} variants; keep it under 200`,
      );
    }

    const existing = await this.prisma.product.findMany({
      where: { parentId, businessId },
      select: { variantName: true },
    });
    const taken = new Set(existing.map((e) => e.variantName));

    const created: ProductDetail[] = [];
    for (const combo of combos) {
      const label = Object.values(combo).join(' / ');
      if (taken.has(label)) continue;
      const suffix = Object.values(combo)
        .map((v) => v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())
        .join('-');
      const product = await this.prisma.product.create({
        data: {
          businessId,
          parentId,
          variantName: label,
          attributes: combo,
          name: `${parent.name} - ${label}`,
          // A variant needs its own SKU; without one on the parent there is
          // nothing to derive it from, so it is left blank to be filled in.
          sku: parent.sku ? `${parent.sku}-${suffix}` : null,
          description: parent.description,
          brand: parent.brand,
          imageUrl: parent.imageUrl,
          unit: parent.unit,
          costPrice: dto.costPrice ?? parent.costPrice,
          sellingPrice: dto.sellingPrice ?? parent.sellingPrice,
          taxId: parent.taxId,
          taxRate: parent.taxRate,
          isTaxable: parent.isTaxable,
          isRxRequired: parent.isRxRequired,
          trackBatches: parent.trackBatches,
          trackSerials: parent.trackSerials,
          reorderLevel: parent.reorderLevel,
          ...(parent.categories.length
            ? { categories: { connect: parent.categories.map((c) => ({ id: c.id })) } }
            : {}),
        },
        include: this.detailInclude,
      });
      await this.seedStockRows(businessId, product.id);
      created.push(product);
    }
    return { created: created.length, skipped: combos.length - created.length, variants: created };
  }

  /** The variants of one style, with their per-store stock. */
  async listVariants(businessId: string, parentId: string) {
    await this.findOne(businessId, parentId);
    return this.prisma.product.findMany({
      where: { parentId, businessId },
      orderBy: { name: 'asc' },
      include: {
        ...this.detailInclude,
        stockItems: { select: { storeId: true, quantity: true } },
      },
    });
  }

  private async assertParent(businessId: string, parentId: string) {
    const parent = await this.prisma.product.findFirst({
      where: { id: parentId, businessId },
      select: { parentId: true },
    });
    if (!parent) throw new BadRequestException('Invalid parent product');
    if (parent.parentId) {
      throw new BadRequestException('Variants cannot be nested');
    }
  }

  // ---- Bulk import / export ----

  /** Flattened product rows for CSV export. */
  async exportAll(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
      include: { categories: { select: { name: true } } },
    });
    return products.map((p) => ({
      name: p.name,
      sku: p.sku ?? '',
      barcode: p.barcode ?? '',
      brand: p.brand ?? '',
      unit: p.unit,
      costPrice: Number(p.costPrice),
      sellingPrice: Number(p.sellingPrice),
      taxRate: Number(p.taxRate),
      reorderLevel: p.reorderLevel,
      variantOf: p.parentId ?? '',
      variantName: p.variantName ?? '',
      categories: p.categories.map((c) => c.name).join('|'),
      isActive: p.isActive,
    }));
  }

  /**
   * Upsert products from imported rows, keyed by SKU within the business.
   * Rows without an SKU are always created. Returns a per-row summary.
   */
  async bulkImport(businessId: string, items: Record<string, unknown>[]) {
    if (items.length > 5000) {
      throw new BadRequestException('Import is limited to 5000 rows at a time');
    }
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const str = (v: unknown) => (v == null ? '' : String(v).trim());

    let created = 0;
    let updated = 0;
    const errors: { row: number; error: string }[] = [];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      try {
        const name = str(it.name);
        if (!name) throw new Error('Name is required');
        const data = {
          name,
          barcode: str(it.barcode) || null,
          brand: str(it.brand) || null,
          unit: normalizeUnit(it.unit) ?? 'pcs',
          costPrice: num(it.costPrice),
          sellingPrice: num(it.sellingPrice),
          taxRate: num(it.taxRate),
          reorderLevel: Math.round(num(it.reorderLevel)),
        };
        const sku = str(it.sku) || null;
        const existing = sku
          ? await this.prisma.product.findFirst({ where: { businessId, sku } })
          : null;
        if (existing) {
          await this.prisma.product.update({ where: { id: existing.id }, data });
          updated++;
        } else {
          const product = await this.prisma.product.create({
            data: { businessId, sku, ...data },
          });
          await this.seedStockRows(businessId, product.id);
          created++;
        }
      } catch (e) {
        errors.push({ row: i + 1, error: (e as Error).message });
      }
    }
    return { created, updated, errors };
  }

  async remove(businessId: string, id: string) {
    await this.findOne(businessId, id);
    // Soft delete keeps sales/purchase history intact. Retiring a style
    // retires its variants too -- leaving them sellable under a deleted
    // parent is never what was meant.
    await this.prisma.product.updateMany({
      where: { parentId: id, businessId },
      data: { isActive: false },
    });
    return this.prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /** Resolve a tax id to its current rate (validating tenant ownership). */
  private async resolveTaxRate(businessId: string, taxId?: string) {
    if (!taxId) return undefined;
    const tax = await this.prisma.tax.findFirst({
      where: { id: taxId, businessId },
    });
    if (!tax) throw new BadRequestException('Invalid tax');
    return Number(tax.rate);
  }

  /** Ensure every supplied category id belongs to this business. */
  private async assertCategories(businessId: string, categoryIds?: string[]) {
    if (!categoryIds?.length) return;
    const count = await this.prisma.category.count({
      where: { id: { in: categoryIds }, businessId },
    });
    if (count !== categoryIds.length) {
      throw new BadRequestException('One or more categories are invalid');
    }
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
