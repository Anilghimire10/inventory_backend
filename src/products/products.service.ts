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
import { expiredCutoff, inDateFirst, isExpired, soonCutoff } from '../common/expiry';
import { readProductRow } from './product-import';
import { paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';
import { convertToBatches } from '../inventory/inventory.service';

const DETAIL_INCLUDE = {
  categories: { select: { id: true, name: true } },
  tax: { select: { id: true, name: true, rate: true } },
  _count: { select: { variants: { where: { isActive: true } } } },
} satisfies Prisma.ProductInclude;

type ProductDetail = Prisma.ProductGetPayload<{ include: typeof DETAIL_INCLUDE }>;

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  private readonly detailInclude = DETAIL_INCLUDE;

  async create(businessId: string, dto: CreateProductDto) {
    // storeIds is availability, not a product column — it must not reach
    // Prisma via ...rest.
    const { categoryIds, expiryDate, taxId, storeIds, ...rest } = dto;
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
      await this.seedStockRows(businessId, product.id, storeIds);
      return product;
    } catch (e) {
      throw this.handleUnique(e);
    }
  }

  /**
   * Give a brand-new product a zero-quantity StockItem in each store that
   * carries it, so it shows up on the stock page immediately (the stock list
   * reads StockItem rows, not products). Without this it stays invisible until
   * the first purchase/adjustment creates a row.
   *
   * A StockItem row *is* the record that a store carries the product -- there
   * is no separate availability table -- so seeding only the chosen stores is
   * what keeps a multi-branch catalog per-store. Omitting `storeIds` stocks
   * every store, which is the right default for the single-store businesses
   * that are most of them.
   */
  private async seedStockRows(
    businessId: string,
    productId: string,
    storeIds?: string[],
  ) {
    const stores = await this.prisma.store.findMany({
      where: {
        businessId,
        ...(storeIds?.length ? { id: { in: storeIds } } : {}),
      },
      select: { id: true },
    });
    if (storeIds?.length && stores.length !== new Set(storeIds).size) {
      throw new BadRequestException('One or more stores are invalid');
    }
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
      // A store carries a product exactly when it has a StockItem row for it.
      ...(q.storeId ? { stockItems: { some: { storeId: q.storeId } } } : {}),
      ...(q.activeOnly !== false ? { isActive: true } : {}),
      ...(q.categoryId ? { categories: { some: { id: q.categoryId } } } : {}),
      ...(q.taxId ? { taxId: q.taxId } : {}),
      ...(q.ids?.length ? { id: { in: q.ids } } : {}),
      ...(q.parentId ? { parentId: q.parentId } : {}),
      ...(q.excludeVariants ? { parentId: null } : {}),
      ...(q.trackSerials ? { trackSerials: true } : {}),
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
      // Under AND, so it can't collide with the search's OR.
      ...(q.expiry ? { AND: [this.expiryWhere(q.expiry, q.storeId)] } : {}),
    };

    const page = { where, skip: q.skip, take: q.limit, orderBy: { name: 'asc' as const } };

    // Unscoped: no store, so there is no single on-hand figure to report.
    if (!q.storeId) {
      const [data, total] = await Promise.all([
        this.prisma.product.findMany({ ...page, include: this.detailInclude }),
        this.prisma.product.count({ where }),
      ]);
      return paginate(await this.withExpiry(data), total, q.page, q.limit);
    }

    // Scoped to a store: carry that store's stock on the row.
    //
    // The POS used to mirror the store's entire StockItem table into the
    // browser to get these two numbers -- 100 rows per request, `ceil(N/100)`
    // requests in parallel, re-fired after every sale, adjustment, receive,
    // transfer and stock take. With the throttler at 120 requests/minute per
    // IP and every till in a shop behind one NAT address, a 5,000-SKU store
    // throttled itself out at roughly two sales a minute.
    //
    // The join costs nothing extra: `where` above already filters on
    // `stockItems: { some: { storeId } }`, so the row is being visited anyway.
    // `@@unique([storeId, productId])` means at most one row comes back.
    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        ...page,
        include: {
          ...this.detailInclude,
          stockItems: {
            where: { storeId: q.storeId },
            select: { quantity: true, reorderLevel: true, clearancePrice: true, clearanceFor: true },
          },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    const rows = data.map(({ stockItems, ...product }) => {
      const here = stockItems[0];
      return {
        ...product,
        onHandQty: here?.quantity ?? new Prisma.Decimal(0),
        // Per-store override when set, otherwise the product default -- the
        // same rule as InventoryService.lowStock()'s
        // COALESCE(NULLIF(si."reorderLevel", 0), p."reorderLevel").
        effectiveReorderLevel: here?.reorderLevel || product.reorderLevel,
        // A product keeping one expiry date on itself, marked down at this
        // store: every unit, while that date stands and hasn't passed.
        ...(here?.clearancePrice != null &&
        !product.trackBatches &&
        product.expiryDate &&
        here.clearanceFor?.getTime() === product.expiryDate.getTime() &&
        !isExpired(product.expiryDate)
          ? { clearance: [{ quantity: null, price: Number(here.clearancePrice) }] }
          : {}),
      };
    });
    return paginate(await this.withExpiry(rows, q.storeId), total, q.page, q.limit);
  }

  /**
   * Products past (or near) their expiry: the product's own date, or a batch
   * that still holds stock -- at `storeId` when given, else at any store.
   */
  private expiryWhere(kind: 'expired' | 'soon', storeId?: string): Prisma.ProductWhereInput {
    const now = new Date();
    const range =
      kind === 'expired' ? { lte: expiredCutoff(now) } : { gt: expiredCutoff(now), lte: soonCutoff(now) };
    return {
      OR: [
        { expiryDate: range },
        {
          batches: {
            some: { quantity: { gt: 0 }, expiryDate: range, ...(storeId ? { storeId } : {}) },
          },
        },
      ],
    };
  }

  /**
   * Batch expiry on each row, for the badges on the product list and the till:
   * how much sits in batches already past their date, and when the next
   * in-date batch expires. At `storeId` when given (the till sells from one
   * store), otherwise across all of them. One query for the whole page.
   */
  private async withExpiry<T extends { id: string; trackBatches: boolean }>(rows: T[], storeId?: string) {
    const ids = rows.filter((r) => r.trackBatches).map((r) => r.id);
    // At one store the till needs the expiry summary and any clearance
    // pricing, and one read of that store's batches -- undated ones and the
    // markdown included, in the order a sale draws them -- serves both. They
    // used to be up to three queries one after another, each a full round
    // trip to the database on the till's busiest screen.
    const batches = ids.length
      ? await this.prisma.batch.findMany({
          where: {
            productId: { in: ids },
            quantity: { gt: 0 },
            ...(storeId ? { storeId } : { expiryDate: { not: null } }),
          },
          ...(storeId ? { orderBy: [{ expiryDate: 'asc' as const }, { createdAt: 'asc' as const }] } : {}),
          select: { productId: true, expiryDate: true, quantity: true, clearancePrice: true },
        })
      : [];
    const cutoff = expiredCutoff();
    const info = new Map<string, { expiredQty: number; nextBatchExpiry: Date | null }>();
    for (const b of batches) {
      if (!b.expiryDate) continue;
      const e = info.get(b.productId) ?? { expiredQty: 0, nextBatchExpiry: null };
      if (b.expiryDate <= cutoff) e.expiredQty = Math.round((e.expiredQty + Number(b.quantity)) * 1000) / 1000;
      else if (!e.nextBatchExpiry || b.expiryDate < e.nextBatchExpiry) e.nextBatchExpiry = b.expiryDate;
      info.set(b.productId, e);
    }
    const tiers = storeId ? ProductsService.clearanceTiers(batches, cutoff) : new Map();
    return rows.map((r) => ({
      ...r,
      expiry: info.get(r.id) ?? { expiredQty: 0, nextBatchExpiry: null },
      ...(tiers.has(r.id) ? { clearance: tiers.get(r.id) } : {}),
    }));
  }

  /**
   * How the till prices a batch-tracked product with a batch marked down:
   * its in-date batches in the order a sale draws them (soonest expiry
   * first, see inDateFirst), each with its clearance price or null for full
   * price. Units past these are full price. Only for products with an
   * in-date batch marked down. `batches` is one store's, soonest expiry first.
   */
  private static clearanceTiers(
    batches: { productId: string; expiryDate: Date | null; quantity: Prisma.Decimal; clearancePrice: Prisma.Decimal | null }[],
    cutoff: Date,
  ) {
    const tiers = new Map<string, { quantity: number; price: number | null }[]>();
    const inDate = (d: Date | null) => !d || d > cutoff;
    const marked = new Set(
      batches.filter((b) => b.clearancePrice !== null && inDate(b.expiryDate)).map((b) => b.productId),
    );
    if (!marked.size) return tiers;
    for (const b of inDateFirst(batches.filter((x) => marked.has(x.productId)), cutoff)) {
      if (!inDate(b.expiryDate)) continue; // the till sells these last, at full price
      const list = tiers.get(b.productId) ?? [];
      list.push({
        quantity: Number(b.quantity),
        price: b.clearancePrice === null ? null : Number(b.clearancePrice),
      });
      tiers.set(b.productId, list);
    }
    return tiers;
  }

  /**
   * Set which stores carry a product — the multi-branch catalog control.
   *
   * There is no availability table: a zero-quantity StockItem row *is* the
   * record that a store carries the item, which is why adding a store seeds a
   * row and dropping one deletes it. A drop is refused while that branch still
   * holds stock, batches or serials, because deleting the row would take the
   * quantity with it and silently write the stock off.
   *
   * Variants move with their parent. A style carried at one branch whose
   * variants lived at another would put a size on a shelf that does not stock
   * the style.
   */
  async setStores(businessId: string, productId: string, storeIds: string[]) {
    const wanted = [...new Set(storeIds)];
    if (!wanted.length) {
      throw new BadRequestException(
        'Pick at least one store — a product carried nowhere is invisible',
      );
    }
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
      select: { id: true, name: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const stores = await this.prisma.store.findMany({
      where: { businessId, id: { in: wanted } },
      select: { id: true, name: true },
    });
    if (stores.length !== wanted.length) {
      throw new BadRequestException('One or more stores are invalid');
    }

    const variants = await this.prisma.product.findMany({
      where: { parentId: productId, businessId },
      select: { id: true },
    });
    const productIds = [product.id, ...variants.map((v) => v.id)];

    const current = await this.prisma.stockItem.findMany({
      where: { productId: { in: productIds } },
      select: { storeId: true, productId: true, quantity: true },
    });
    const dropping = [...new Set(current.map((r) => r.storeId))].filter(
      (id) => !wanted.includes(id),
    );

    if (dropping.length) {
      const held = current.filter(
        (r) => dropping.includes(r.storeId) && Number(r.quantity) !== 0,
      );
      const [batches, serials] = await Promise.all([
        this.prisma.batch.findMany({
          where: { productId: { in: productIds }, storeId: { in: dropping } },
          select: { storeId: true },
        }),
        this.prisma.serial.findMany({
          where: { productId: { in: productIds }, storeId: { in: dropping } },
          select: { storeId: true },
        }),
      ]);
      const blocked = new Set<string>([
        ...held.map((r) => r.storeId),
        ...batches.map((r) => r.storeId),
        // Serial.storeId is nullable — an unassigned unit pins no store.
        ...serials.flatMap((r) => (r.storeId ? [r.storeId] : [])),
      ]);
      if (blocked.size) {
        const all = await this.prisma.store.findMany({
          where: { id: { in: [...blocked] } },
          select: { name: true },
        });
        throw new ConflictException(
          `${product.name} still has stock at ${all
            .map((s) => s.name)
            .join(', ')}. Move or write it off before dropping the store.`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (dropping.length) {
        // The checks above read `current` outside this transaction, so they go
        // stale: a sale, transfer or receipt landing in between would have its
        // stock deleted here silently, with no StockMovement to say where it
        // went -- the one way this schema can otherwise lose stock untraceably.
        //
        // So the delete carries the condition itself. `quantity: 0` is
        // evaluated against the live, locked row rather than the earlier read,
        // and any mismatch in the count means a row gained stock (skipped) or
        // appeared (extra) while we worked. Either way nothing is dropped: the
        // throw rolls the whole transaction back and the caller retries.
        const expected = current.filter((r) => dropping.includes(r.storeId)).length;
        const { count } = await tx.stockItem.deleteMany({
          where: {
            productId: { in: productIds },
            storeId: { in: dropping },
            quantity: 0,
          },
        });
        if (count !== expected) {
          throw new ConflictException(
            `${product.name} changed stock while its stores were being edited. Nothing was changed — try again.`,
          );
        }
      }
      // Every wanted (store, product) pair, unconditionally. `skipDuplicates`
      // makes this an ON CONFLICT DO NOTHING, so existing rows keep their
      // quantity -- which is both idempotent and free of the stale `current`
      // read the old `have` set depended on.
      const rows = productIds.flatMap((pid) =>
        wanted.map((sid) => ({ businessId, storeId: sid, productId: pid, quantity: 0 })),
      );
      await tx.stockItem.createMany({ data: rows, skipDuplicates: true });
    });

    return { id: product.id, storeIds: wanted, variantsUpdated: variants.length };
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
    const before = await this.findOne(businessId, id);
    // Switching batches on: the stock on the shelf keeps the date it has, as
    // a batch, instead of being left in none (see convertToBatches). The
    // form's product-level date goes with it -- it is now the batch's.
    const toBatches = dto.trackBatches === true && !before.trackBatches;
    // storeIds is availability, not a product column — it must not reach
    // Prisma via ...rest.
    const { categoryIds, expiryDate, taxId, storeIds, ...rest } = dto;
    // create() calls assertParent(); update() spread parentId straight through
    // ...rest unchecked, and UpdateProductDto extends PartialType(Create...) so
    // the field is accepted. The FK only requires that *some* Product row
    // exists, so a product could be pointed at itself, at a variant (nesting,
    // which generateVariants explicitly forbids), or at another tenant's
    // product. Same guard, same place in the flow.
    if (rest.parentId !== undefined && rest.parentId !== null) {
      if (rest.parentId === id) {
        throw new BadRequestException('A product cannot be its own variant');
      }
      await this.assertParent(businessId, rest.parentId);
      // A style that already has variants cannot itself become one -- that
      // would orphan its children underneath a variant.
      const children = await this.prisma.product.count({
        where: { parentId: id, businessId },
      });
      if (children > 0) {
        throw new BadRequestException(
          'This product already has variants, so it cannot become a variant itself',
        );
      }
    }
    await this.assertCategories(businessId, categoryIds);
    const write = async (db: Prisma.TransactionClient | PrismaService) =>
      db.product.update({
        where: { id },
        data: {
          ...rest,
          // Choosing a tax takes its current rate; choosing no tax (null)
          // clears both, so the product charges exactly what its form shows.
          // Clearing the id alone used to leave the old rate being charged.
          ...(taxId !== undefined
            ? taxId
              ? { taxId, taxRate: await this.resolveTaxRate(businessId, taxId) }
              : { taxId: null, taxRate: 0 }
            : {}),
          ...(expiryDate !== undefined && !toBatches
            ? { expiryDate: expiryDate ? new Date(expiryDate) : null }
            : {}),
          // `set` replaces the full category list when the field is provided.
          ...(categoryIds !== undefined
            ? { categories: { set: categoryIds.map((cid) => ({ id: cid })) } }
            : {}),
        },
        include: this.detailInclude,
      });

    try {
      return toBatches
        ? await this.prisma.$transaction(async (tx) => {
            // A date typed in the same save is the date of the stock on hand:
            // set it first so the conversion carries it, rather than the old
            // date (or none) while the typed one was dropped.
            if (expiryDate !== undefined) {
              await tx.product.update({
                where: { id },
                data: { expiryDate: expiryDate ? new Date(expiryDate) : null },
              });
            }
            await convertToBatches(tx, id);
            return write(tx);
          }, TX_OPTS)
        : await write(this.prisma);
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

    // A variant is carried wherever its parent is: generating one into a
    // store that does not stock the style would put it on that branch's shelf
    // by itself.
    const parentStores = await this.prisma.stockItem.findMany({
      where: { productId: parentId },
      select: { storeId: true },
    });
    const variantStoreIds = parentStores.map((r) => r.storeId);

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
      await this.seedStockRows(businessId, product.id, variantStoreIds);
      created.push(product);
    }
    return { created: created.length, skipped: combos.length - created.length, variants: created };
  }

  /** The variants of one style, with their per-store stock. */
  async listVariants(businessId: string, parentId: string) {
    await this.findOne(businessId, parentId);
    return this.prisma.product.findMany({
      where: { parentId, businessId, isActive: true },
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
    // Every column the import reads, in the same shape, so a file exported,
    // edited in Excel and imported back changes only what was edited.
    const yesNo = (b: boolean) => (b ? 'yes' : 'no');
    return products.map((p) => ({
      name: p.name,
      sku: p.sku ?? '',
      barcode: p.barcode ?? '',
      brand: p.brand ?? '',
      description: p.description ?? '',
      unit: p.unit,
      costPrice: Number(p.costPrice),
      sellingPrice: Number(p.sellingPrice),
      taxRate: Number(p.taxRate),
      isTaxable: yesNo(p.isTaxable),
      reorderLevel: p.reorderLevel,
      categories: p.categories.map((c) => c.name).join('|'),
      isRxRequired: yesNo(p.isRxRequired),
      expiryDate: p.expiryDate ? p.expiryDate.toISOString().slice(0, 10) : '',
      trackBatches: yesNo(p.trackBatches),
      trackSerials: yesNo(p.trackSerials),
      variantName: p.variantName ?? '',
      isActive: yesNo(p.isActive),
    }));
  }

  /**
   * Upsert products from imported rows, keyed by SKU within the business.
   * Rows without an SKU are always created. Returns a per-row summary.
   *
   * Planned, then written in chunks. The original walked the rows one at a
   * time -- a `findFirst` plus a `create`/`update` plus a `seedStockRows` per
   * row, each awaited -- so the advertised 5,000-row import was 15,000+
   * sequential round trips to Supabase. It could not finish inside any
   * sensible proxy timeout, and because nothing was transactional a timeout
   * left a half-imported catalog with nothing to roll back to.
   *
   * Three passes now:
   *   1. parse and validate every row in memory, resolving all existing SKUs
   *      in a single query;
   *   2. write the plan in chunks, each chunk one pipelined transaction;
   *   3. seed stock rows for everything created, as one `createMany`.
   */
  async bulkImport(businessId: string, items: Record<string, unknown>[], opts: { dryRun?: boolean } = {}) {
    if (items.length > 5000) {
      throw new BadRequestException('Import is limited to 5000 rows at a time');
    }
    const errors: { row: number; error: string }[] = [];

    // ---- Pass 1: read every row ---------------------------------------
    // A cell that is blank (or a column that isn't in the file) means "leave
    // it as it is" on an existing product and "use the default" on a new one.
    // It used to mean 0: re-importing a sheet with an empty cost column set
    // every product's cost to nothing, and "1,200" -- how Excel writes a
    // thousand -- silently became a price of 0. Now a number is read the way
    // a person writes it, and anything unreadable is refused with its row.
    type Fields = {
      name?: string;
      barcode?: string | null;
      brand?: string | null;
      description?: string | null;
      unit?: string;
      costPrice?: number;
      sellingPrice?: number;
      taxRate?: number;
      reorderLevel?: number;
      isTaxable?: boolean;
      isRxRequired?: boolean;
      expiryDate?: Date | null;
      // New products only: switching tracking on a product that already has
      // stock would leave its units without batches or serials on file.
      trackBatches?: boolean;
      trackSerials?: boolean;
    };
    type Parsed = { row: number; sku: string | null; barcode: string | null; fields: Fields; categories?: string[] };
    const parsed: Parsed[] = [];

    for (let i = 0; i < items.length; i++) {
      const row = i + 1;
      try {
        parsed.push({ row, ...readProductRow(items[i]) });
      } catch (e) {
        errors.push({ row, error: (e as Error).message });
      }
    }

    // ---- Pass 2: match to existing products -----------------------------
    // By SKU first; a row without one by barcode, so a product exported
    // without a SKU updates itself on the way back in rather than coming
    // back as a copy.
    const skus = [...new Set(parsed.map((r) => r.sku).filter((v): v is string => !!v))];
    const barcodes = [...new Set(parsed.filter((r) => !r.sku && r.barcode).map((r) => r.barcode as string))];
    const existing = skus.length || barcodes.length
      ? await this.prisma.product.findMany({
          where: {
            businessId,
            OR: [
              ...(skus.length ? [{ sku: { in: skus } }] : []),
              ...(barcodes.length ? [{ barcode: { in: barcodes } }] : []),
            ],
          },
          select: { id: true, sku: true, barcode: true },
        })
      : [];
    const idBySku = new Map(existing.filter((p) => p.sku).map((p) => [p.sku as string, p.id]));
    const idByBarcode = new Map(existing.filter((p) => p.barcode).map((p) => [p.barcode as string, p.id]));

    type Op = { row: number; repeats: number; fields: Fields; categories?: string[] } & (
      | { kind: 'create'; sku: string | null }
      | { kind: 'update'; id: string }
    );
    const ops: Op[] = [];
    const seen = new Map<string, number>();
    for (const r of parsed) {
      // Same identity twice in one file: the later row wins, merged over the
      // earlier one, and counts as a repeat.
      const key = r.sku ? `sku:${r.sku}` : r.barcode ? `bc:${r.barcode}` : null;
      const at = key ? seen.get(key) : undefined;
      if (at !== undefined) {
        ops[at] = {
          ...ops[at],
          row: r.row,
          repeats: ops[at].repeats + 1,
          fields: { ...ops[at].fields, ...r.fields },
          categories: r.categories ?? ops[at].categories,
        };
        continue;
      }
      if (key) seen.set(key, ops.length);
      const id = r.sku ? idBySku.get(r.sku) : r.barcode ? idByBarcode.get(r.barcode) : undefined;
      if (id) {
        const { trackBatches: _b, trackSerials: _s, ...fields } = r.fields;
        ops.push({ kind: 'update', row: r.row, repeats: 0, id, fields, categories: r.categories });
      } else if (!r.fields.name) {
        errors.push({ row: r.row, error: 'Name is required for a new product' });
      } else {
        ops.push({ kind: 'create', row: r.row, repeats: 0, sku: r.sku, fields: r.fields, categories: r.categories });
      }
    }

    const summary = {
      created: ops.filter((o) => o.kind === 'create').length,
      updated: ops.filter((o) => o.kind === 'update').length + ops.reduce((n, o) => n + o.repeats, 0),
    };
    if (opts.dryRun) {
      errors.sort((a, b) => a.row - b.row);
      return {
        dryRun: true,
        ...summary,
        errors,
        // What the first rows will do, so the screen can show a sample.
        preview: ops.slice(0, 20).map((o) => ({
          row: o.row,
          action: o.kind,
          name: o.fields.name ?? null,
          sku: o.kind === 'create' ? o.sku : null,
        })),
      };
    }

    // Categories named in the file: found by name, created when new.
    const categoryNames = [...new Set(ops.flatMap((o) => o.categories ?? []))];
    const categoryIds = new Map<string, string>();
    if (categoryNames.length) {
      const found = await this.prisma.category.findMany({
        where: { businessId, name: { in: categoryNames, mode: 'insensitive' } },
        select: { id: true, name: true },
      });
      for (const c of found) categoryIds.set(c.name.toLowerCase(), c.id);
      for (const name of categoryNames) {
        if (categoryIds.has(name.toLowerCase())) continue;
        const c = await this.prisma.category.create({ data: { businessId, name }, select: { id: true } });
        categoryIds.set(name.toLowerCase(), c.id);
      }
    }
    const cats = (names?: string[]) =>
      names?.map((n) => ({ id: categoryIds.get(n.toLowerCase())! })).filter((c) => c.id);

    // ---- Pass 3: write ----------------------------------------------------
    // 200 rows per transaction. Small enough that a chunk's locks are held
    // briefly and a failure costs one chunk rather than the import; large
    // enough that 5,000 rows is ~25 batches rather than 5,000 round trips.
    const CHUNK = 200;
    let created = 0;
    let updated = 0;
    const newProductIds: string[] = [];

    const tally = (op: Op, id: string) => {
      if (op.kind === 'create') {
        created++;
        newProductIds.push(id);
      } else {
        updated++;
      }
      updated += op.repeats;
    };

    const runOp = (op: Op) =>
      op.kind === 'create'
        ? this.prisma.product.create({
            data: {
              businessId,
              sku: op.sku,
              ...op.fields,
              name: op.fields.name!,
              unit: op.fields.unit ?? 'pcs',
              ...(op.categories ? { categories: { connect: cats(op.categories) } } : {}),
            },
            select: { id: true },
          })
        : this.prisma.product.update({
            where: { id: op.id },
            data: {
              ...op.fields,
              // A categories column replaces the product's categories; no
              // column leaves them alone.
              ...(op.categories ? { categories: { set: cats(op.categories) } } : {}),
            },
            select: { id: true },
          });

    for (let start = 0; start < ops.length; start += CHUNK) {
      const slice = ops.slice(start, start + CHUNK);
      try {
        // Array form, not an interactive callback: Prisma pipelines the whole
        // batch over one connection instead of awaiting each statement, and
        // `create` still hands back the ids the stock seeding needs.
        const written = await this.prisma.$transaction(slice.map(runOp));
        for (let i = 0; i < slice.length; i++) tally(slice[i], written[i].id);
      } catch {
        // The batch is all-or-nothing, so one bad row (a duplicate barcode,
        // say) would take its whole chunk down and leave the operator with no
        // idea which row was at fault. Replay the chunk row by row: slower,
        // but only for a chunk that actually failed, and every surviving row
        // still lands with the offender named.
        for (const op of slice) {
          try {
            tally(op, (await runOp(op)).id);
          } catch (e) {
            errors.push({ row: op.row, error: this.handleUnique(e).message });
          }
        }
      }
    }

    // One createMany for (new products x stores) rather than a query pair per
    // product. A CSV row names no store, so an imported product is stocked
    // everywhere; narrow it afterwards from the product's store list.
    if (newProductIds.length) {
      const stores = await this.prisma.store.findMany({
        where: { businessId },
        select: { id: true },
      });
      if (stores.length) {
        const rows = newProductIds.flatMap((productId) =>
          stores.map((s) => ({ businessId, storeId: s.id, productId, quantity: 0 })),
        );
        for (let start = 0; start < rows.length; start += 1000) {
          await this.prisma.stockItem.createMany({
            data: rows.slice(start, start + 1000),
            skipDuplicates: true,
          });
        }
      }
    }

    errors.sort((a, b) => a.row - b.row);
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
  private async resolveTaxRate(businessId: string, taxId?: string | null) {
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
