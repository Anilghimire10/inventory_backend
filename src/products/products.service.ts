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

    const page = { where, skip: q.skip, take: q.limit, orderBy: { name: 'asc' as const } };

    // Unscoped: no store, so there is no single on-hand figure to report.
    if (!q.storeId) {
      const [data, total] = await Promise.all([
        this.prisma.product.findMany({ ...page, include: this.detailInclude }),
        this.prisma.product.count({ where }),
      ]);
      return paginate(data, total, q.page, q.limit);
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
            select: { quantity: true, reorderLevel: true },
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
      };
    });
    return paginate(rows, total, q.page, q.limit);
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
    await this.findOne(businessId, id);
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
  async bulkImport(businessId: string, items: Record<string, unknown>[]) {
    if (items.length > 5000) {
      throw new BadRequestException('Import is limited to 5000 rows at a time');
    }
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    // Objects/arrays have no sensible cell value -- String() would silently
    // stringify them to "[object Object]" and import that as the product name.
    // Treated as blank so the row fails validation and is reported instead.
    const str = (v: unknown) => {
      if (typeof v === 'string') return v.trim();
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
        return String(v);
      }
      return '';
    };

    const errors: { row: number; error: string }[] = [];

    // ---- Pass 1: parse ----------------------------------------------------
    type Parsed = {
      row: number;
      sku: string | null;
      data: {
        name: string;
        barcode: string | null;
        brand: string | null;
        unit: string;
        costPrice: number;
        sellingPrice: number;
        taxRate: number;
        reorderLevel: number;
      };
    };
    const parsed: Parsed[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const name = str(it.name);
      if (!name) {
        errors.push({ row: i + 1, error: 'Name is required' });
        continue;
      }
      const sku = str(it.sku);
      const barcode = str(it.barcode);
      const brand = str(it.brand);
      // Same caps as CreateProductDto. Rows never pass through the DTO, and
      // this route keeps the large body limit, so without this a single cell
      // could carry megabytes into the product table.
      const tooLong = (
        [
          ['Name', name, 200],
          ['SKU', sku, 100],
          ['Barcode', barcode, 100],
          ['Brand', brand, 200],
        ] as const
      ).find(([, value, max]) => value.length > max);
      if (tooLong) {
        errors.push({
          row: i + 1,
          error: `${tooLong[0]} is longer than ${tooLong[2]} characters`,
        });
        continue;
      }
      parsed.push({
        row: i + 1,
        sku: sku || null,
        data: {
          name,
          barcode: barcode || null,
          brand: brand || null,
          unit: normalizeUnit(it.unit) ?? 'pcs',
          costPrice: num(it.costPrice),
          sellingPrice: num(it.sellingPrice),
          taxRate: num(it.taxRate),
          reorderLevel: Math.round(num(it.reorderLevel)),
        },
      });
    }

    // Every existing SKU in one query instead of a findFirst per row.
    const skus = [...new Set(parsed.map((r) => r.sku).filter((v): v is string => !!v))];
    const existing = skus.length
      ? await this.prisma.product.findMany({
          where: { businessId, sku: { in: skus } },
          select: { id: true, sku: true },
        })
      : [];
    const idBySku = new Map(existing.map((p) => [p.sku as string, p.id]));

    // ---- Pass 2: plan -----------------------------------------------------
    // A SKU repeated inside one file collapses to its last row, which is what
    // the row-at-a-time version ended up with: each later occurrence found the
    // product the earlier one had just written and overwrote it. The counts
    // are reported the same way too -- one create plus an update per repeat
    // for a new SKU, an update per row for one that already existed.
    type Op = { row: number; repeats: number; data: Parsed['data'] } & (
      | { kind: 'create'; sku: string | null }
      | { kind: 'update'; id: string }
    );

    const ops: Op[] = [];
    const seen = new Map<string, number>();
    for (const r of parsed) {
      if (!r.sku) {
        // No SKU is no identity: always a new product, never deduped.
        ops.push({ kind: 'create', row: r.row, repeats: 0, sku: null, data: r.data });
        continue;
      }
      const at = seen.get(r.sku);
      if (at !== undefined) {
        // Last row wins, and the repeat is counted -- but only once the write
        // succeeds, so a chunk that fails doesn't inflate the summary.
        ops[at] = { ...ops[at], row: r.row, repeats: ops[at].repeats + 1, data: r.data };
        continue;
      }
      seen.set(r.sku, ops.length);
      const id = idBySku.get(r.sku);
      ops.push(
        id
          ? { kind: 'update', row: r.row, repeats: 0, id, data: r.data }
          : { kind: 'create', row: r.row, repeats: 0, sku: r.sku, data: r.data },
      );
    }

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
      // Each collapsed repeat of this SKU was an update in the old row-at-a-
      // time version, so it still reads as one.
      updated += op.repeats;
    };

    const runOp = (op: Op) =>
      op.kind === 'create'
        ? this.prisma.product.create({
            data: { businessId, sku: op.sku, ...op.data },
            select: { id: true },
          })
        : this.prisma.product.update({
            where: { id: op.id },
            data: op.data,
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
