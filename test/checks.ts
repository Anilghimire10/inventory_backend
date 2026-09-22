/**
 * Money/quantity self-checks. No framework: `npm run check` (ts-node).
 *
 * These cover the arithmetic a silent bug would cost a real shop money on --
 * drawer reconciliation and physical counts -- by driving the real services
 * with a stub Prisma client. Everything else needs a database and belongs in
 * an integration suite.
 */
import assert from 'assert';
import { createHash } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PaymentMethod, Prisma, SaleStatus, UserRole } from '@prisma/client';
import { ShiftsService } from '../src/shifts/shifts.service';
import { SalesService } from '../src/sales/sales.service';
import { MailService } from '../src/mail/mail.service';
import { AuthService } from '../src/auth/auth.service';
import { AuditService } from '../src/audit/audit.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { ProductsService } from '../src/products/products.service';
import { UsersService } from '../src/users/users.service';
import { StoreScopeGuard } from '../src/common/guards/store-scope.guard';
import { scopeToStore } from '../src/common/store-scope';
import { StoresService } from '../src/stores/stores.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/common/types/auth-user';
import { allowsFraction, normalizeUnit } from '../src/common/units';
import { validateEnv } from '../src/common/env.validation';
import { PrincipalCache } from '../src/common/principal-cache';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { ConfigService } from '@nestjs/config';
import {
  DAY_MS,
  addMonths,
  daysUntil,
  paymentPeriod,
  subscriptionStatus,
  trialEndsAt,
} from '../src/common/subscription';
import { PlatformAdminsService } from '../src/platform/platform-admins.service';
import { PlatformAuditService } from '../src/platform/platform-audit.service';
import { SubscriptionRemindersService } from '../src/platform/subscription-reminders.service';

const stub = <T>(impl: unknown) => impl as T;
const user: AuthUser = {
  userId: 'u1',
  businessId: 'b1',
  storeId: 's1',
  role: 'CASHIER' as AuthUser['role'],
  email: 'cashier@example.com',
};

async function shiftReportBalancesTheDrawer() {
  const sales = [
    // paid in full, cash -> 1000 in the drawer
    { subtotal: 1000, discount: 0, tax: 0, total: 1000, amountPaid: 1000, paymentMethod: PaymentMethod.CASH, items: [{ quantity: 2, returnedQty: 0, lineTotal: 1000 }] },
    // card sale -> revenue, but no cash in the drawer
    { subtotal: 500, discount: 0, tax: 0, total: 500, amountPaid: 500, paymentMethod: PaymentMethod.CARD, items: [{ quantity: 1, returnedQty: 0, lineTotal: 500 }] },
    // half paid in cash, half on credit
    { subtotal: 400, discount: 0, tax: 0, total: 400, amountPaid: 150, paymentMethod: PaymentMethod.MIXED, items: [{ quantity: 1, returnedQty: 0, lineTotal: 400 }] },
    // cash sale with one of two units returned -> 300 back out of the drawer
    { subtotal: 600, discount: 0, tax: 0, total: 600, amountPaid: 600, paymentMethod: PaymentMethod.CASH, items: [{ quantity: 2, returnedQty: 1, lineTotal: 600 }] },
  ];
  const shift = {
    id: 'sh1',
    businessId: 'b1',
    userId: 'u1',
    openedAt: new Date(),
    closedAt: null,
    openingFloat: 5000,
    expectedCash: null,
    countedCash: null,
    variance: null,
  };
  const prisma = stub<PrismaService>({
    shift: {
      findFirst: async () => shift,
      updateMany: async (args: any) => {
        Object.assign(shift, args.data);
        return { count: 1 };
      },
    },
    sale: { findMany: async () => sales },
  });
  const service = new ShiftsService(prisma);

  const x: any = await service.report('b1', 'sh1');
  assert.strictEqual(x.gross, 2500, 'gross is every stamped sale at full value');
  assert.strictEqual(x.refunds, 300, 'one of two units on a 600 line');
  assert.strictEqual(x.net, 2200, 'net = gross - refunds');
  // 5000 float + 1000 cash + 150 cash part of the mixed sale + 600 cash - 300 refund
  assert.strictEqual(x.expectedCash, 6450, 'card and credit money never touches the drawer');
  assert.strictEqual(
    x.byTender.find((t: any) => t.method === PaymentMethod.CARD).amount,
    500,
    'tender split keeps card separate',
  );

  const closed: any = await service.close(user, 'sh1', { countedCash: 6400 });
  assert.strictEqual(closed.variance, -50, 'counted short of expected is a negative variance');
  assert.strictEqual(closed.expectedCash, 6450, 'close snapshots what it computed');
}

async function stockTakePreviewComputesVariances() {
  const prisma = stub<PrismaService>({
    store: { findFirst: async () => ({ id: 's1', name: 'Main' }) },
    product: {
      findMany: async () => [
        { id: 'p1', name: 'Rice', sku: 'R1', unit: 'kg' },
        { id: 'p2', name: 'Soap', sku: 'S1', unit: 'pcs' },
        { id: 'p3', name: 'Oil', sku: 'O1', unit: 'L' },
      ],
    },
    stockItem: {
      findMany: async () => [
        { productId: 'p1', quantity: 10.5 },
        { productId: 'p2', quantity: 4 },
        // p3 has no StockItem row yet -> system quantity is 0
      ],
    },
  });
  const service = new InventoryService(prisma);

  const res: any = await service.stockTake('b1', 'u1', {
    storeId: 's1',
    preview: true,
    counts: [
      { productId: 'p1', counted: 9.25 }, // 1.25 kg short
      { productId: 'p2', counted: 4 }, // spot on -> not adjusted
      { productId: 'p3', counted: 2 }, // found stock the system didn't know about
    ],
  });

  assert.strictEqual(res.counted, 3);
  assert.strictEqual(res.adjusted, 2, 'an exact count posts no adjustment');
  const byId = new Map(res.lines.map((l: any) => [l.productId, l]));
  assert.strictEqual((byId.get('p1') as any).variance, -1.25, 'fractional variance survives');
  assert.strictEqual((byId.get('p2') as any).variance, 0);
  assert.strictEqual((byId.get('p3') as any).variance, 2, 'missing stock row counts as zero');
}

async function reorderSuggestionsGroupBySupplier() {
  const stock = [
    // 2 short of its level, last bought from Acme at 12
    { productId: 'p1', storeId: 's1', quantity: 3, reorderLevel: 0, store: { id: 's1', name: 'Main' }, product: { id: 'p1', name: 'Nails', sku: 'N1', unit: 'pcs', costPrice: 9, reorderLevel: 5 } },
    // per-store override (2) beats the product level (50); also from Acme
    { productId: 'p2', storeId: 's1', quantity: 1, reorderLevel: 2, store: { id: 's1', name: 'Main' }, product: { id: 'p2', name: 'Glue', sku: 'G1', unit: 'pcs', costPrice: 4, reorderLevel: 50 } },
    // never purchased -> no supplier group, falls back to product cost
    { productId: 'p3', storeId: 's1', quantity: 0, reorderLevel: 0, store: { id: 's1', name: 'Main' }, product: { id: 'p3', name: 'Tape', sku: 'T1', unit: 'pcs', costPrice: 7, reorderLevel: 4 } },
    // well stocked -> not suggested at all
    { productId: 'p4', storeId: 's1', quantity: 99, reorderLevel: 0, store: { id: 's1', name: 'Main' }, product: { id: 'p4', name: 'Screws', sku: 'S1', unit: 'pcs', costPrice: 1, reorderLevel: 5 } },
  ];
  const history = [
    { productId: 'p1', costPrice: 12, purchase: { createdAt: new Date('2026-03-01'), supplier: { id: 'sup1', name: 'Acme' } } },
    { productId: 'p1', costPrice: 99, purchase: { createdAt: new Date('2025-01-01'), supplier: { id: 'sup2', name: 'Old Co' } } },
    { productId: 'p2', costPrice: 4.5, purchase: { createdAt: new Date('2026-02-01'), supplier: { id: 'sup1', name: 'Acme' } } },
  ];
  const prisma = stub<PrismaService>({
    // lowStock() is one raw query now: the reorder-point filter runs in SQL
    // rather than in JS. The stub mirrors that filter over the fixtures above
    // -- COALESCE(NULLIF(si.reorderLevel, 0), p.reorderLevel) -- so the rows
    // that exist to test it (p2's per-store override, p4 being well stocked)
    // still earn their place. The SQL itself is exercised against a real
    // database, which no stub can stand in for.
    $queryRaw: async () =>
      stock
        .map((it) => ({
          id: `si-${it.productId}`,
          businessId: 'b1',
          storeId: it.storeId,
          productId: it.productId,
          quantity: it.quantity,
          reorderLevel: it.reorderLevel,
          updatedAt: new Date(),
          effectiveReorderLevel: it.reorderLevel || it.product.reorderLevel,
          productName: it.product.name,
          productSku: it.product.sku,
          productUnit: it.product.unit,
          productCostPrice: it.product.costPrice,
          productReorderLevel: it.product.reorderLevel,
          storeName: it.store.name,
        }))
        .filter(
          (r) =>
            r.effectiveReorderLevel > 0 &&
            Number(r.quantity) <= r.effectiveReorderLevel,
        ),
    // the service asks for newest-first; the stub hands them back that way
    purchaseItem: { findMany: async () => history },
  });
  const service = new PurchasesService(prisma, new InventoryService(prisma));

  const groups: any[] = await service.reorderSuggestions('b1');
  assert.strictEqual(groups.length, 2, 'Acme + the never-purchased bucket');

  const acme = groups.find((g) => g.supplierId === 'sup1');
  assert.deepStrictEqual(
    acme.items.map((i: any) => [i.productId, i.quantity, i.costPrice]),
    [
      ['p1', 7, 12], // 5*2 - 3 on hand, at the latest price, not the 2025 one
      ['p2', 3, 4.5], // store override 2*2 - 1 on hand
    ],
  );
  assert.strictEqual(acme.total, 7 * 12 + 3 * 4.5);

  const orphan = groups.find((g) => g.supplierId === null);
  assert.deepStrictEqual(
    orphan.items.map((i: any) => [i.productId, i.quantity, i.costPrice]),
    [['p3', 8, 7]], // no purchase history -> product cost price
  );
}

async function variantGenerationCoversEveryCombination() {
  const parent = {
    id: 'p1',
    businessId: 'b1',
    parentId: null,
    name: 'Tee',
    sku: 'TEE',
    description: null,
    brand: 'Acme',
    imageUrl: null,
    unit: 'pcs',
    costPrice: 3,
    sellingPrice: 10,
    taxId: null,
    taxRate: 0,
    isTaxable: true,
    isRxRequired: false,
    trackBatches: false,
    trackSerials: false,
    reorderLevel: 2,
    categories: [{ id: 'c1' }],
  };
  const created: any[] = [];
  const seeded: any[] = [];
  const prisma = stub<PrismaService>({
    product: {
      findFirst: async () => parent,
      // "Red / S" was created by an earlier run -- it must not be duplicated.
      findMany: async () => [{ variantName: 'Red / S' }],
      create: async ({ data }: any) => {
        created.push(data);
        return { ...data, id: `v${created.length}` };
      },
    },
    store: {
      // Honours the id filter, so seedStockRows' "are these stores real?"
      // check sees the same set it asked for.
      findMany: async (args: any) => {
        const all = [{ id: 's1' }, { id: 's2' }];
        const ids: string[] | undefined = args?.where?.id?.in;
        return ids ? all.filter((s) => ids.includes(s.id)) : all;
      },
    },
    stockItem: {
      // A variant is carried wherever its parent is: the parent stocks s1
      // only, so every generated variant must land in s1 and not s2.
      findMany: async () => [{ storeId: 's1' }],
      createMany: async ({ data }: any) => {
        seeded.push(...data);
        return { count: data.length };
      },
    },
  });
  const service = new ProductsService(prisma);

  const res: any = await service.generateVariants('b1', 'p1', {
    options: [
      { name: 'Colour', values: ['Red', 'Blue'] },
      { name: 'Size', values: ['S', 'M'] },
    ],
    sellingPrice: 12,
  });

  assert.strictEqual(res.created, 3, '2x2 combinations minus the existing one');
  assert.strictEqual(res.skipped, 1);
  assert.deepStrictEqual(
    created.map((c) => c.variantName),
    ['Red / M', 'Blue / S', 'Blue / M'],
  );
  const blueM = created[2];
  assert.strictEqual(blueM.name, 'Tee - Blue / M');
  assert.strictEqual(blueM.sku, 'TEE-BLUE-M', 'SKU is derived from the parent');
  assert.deepStrictEqual(blueM.attributes, { Colour: 'Blue', Size: 'M' });
  assert.strictEqual(Number(blueM.sellingPrice), 12, 'price override applies');
  assert.strictEqual(Number(blueM.costPrice), 3, 'cost falls back to the parent');
  assert.strictEqual(blueM.parentId, 'p1');

  // The parent is carried at s1 only, so no variant may appear at s2 -- that
  // would put a size on a shelf that does not stock the style.
  assert.strictEqual(seeded.length, 3, 'one stock row per created variant');
  assert.ok(
    seeded.every((r) => r.storeId === 's1'),
    'variants are stocked only where their parent is carried',
  );
}

async function serialRulesGuardEveryUnit() {
  const phone = { name: 'Phone', trackSerials: true };
  const rice = { name: 'Rice', trackSerials: false };

  // A serialised line needs exactly one serial per unit.
  assert.deepStrictEqual(
    InventoryService.checkSerials(phone, 2, [' A1 ', 'A2']),
    ['A1', 'A2'],
    'serials are trimmed',
  );
  assert.throws(() => InventoryService.checkSerials(phone, 2, ['A1']), /needs 2/);
  assert.throws(() => InventoryService.checkSerials(phone, 2, ['A1', 'A1']), /Duplicate/);
  assert.throws(() => InventoryService.checkSerials(phone, 1.5, ['A1']), /whole number/);
  // Un-serialised products must not carry any.
  assert.deepStrictEqual(InventoryService.checkSerials(rice, 3, undefined), []);
  assert.throws(() => InventoryService.checkSerials(rice, 1, ['A1']), /not tracked/);

  // Selling is guarded on IN_STOCK: a unit already sold matches nothing.
  const sold = new Set(['A2']);
  const prisma = stub<PrismaService>({
    serial: {
      updateMany: async ({ where }: any) => ({
        // Selling matches by serial number and skips units already sold;
        // returns address rows by id, which always match.
        count: where.serialNumber
          ? where.serialNumber.in.filter((n: string) => !sold.has(n)).length
          : where.id.in.length,
      }),
      findMany: async ({ take }: any) =>
        [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }].slice(0, take),
    },
  });
  const inventory = new InventoryService(prisma);
  const args = {
    businessId: 'b1',
    storeId: 's1',
    productId: 'p1',
    saleId: 'sale1',
  };
  await inventory.sellSerials(prisma as any, { ...args, serials: ['A1'] });
  await assert.rejects(
    inventory.sellSerials(prisma as any, { ...args, serials: ['A1', 'A2'] }),
    /not in stock/,
    'a unit sold on another ticket cannot be sold again',
  );

  // A return with no serials given falls back to the oldest units sold.
  await inventory.returnSerialsToStock(prisma as any, {
    ...args,
    quantity: 2,
  });
  // ...but asking for more units than the sale holds is refused.
  await assert.rejects(
    inventory.returnSerialsToStock(prisma as any, { ...args, quantity: 9 }),
    /Not enough serialised units/,
  );
}

/**
 * Discrete goods must move in whole numbers, measured ones may not. The guard
 * lives in the shared movement path, so this covers sales, purchases,
 * transfers, adjustments and stock takes at once.
 */
async function unitsGovernFractionalQuantities() {
  // Spellings people actually type fold onto the canonical set.
  assert.strictEqual(normalizeUnit(' Kg '), 'kg');
  assert.strictEqual(normalizeUnit('litre'), 'l');
  assert.strictEqual(normalizeUnit('pieces'), 'pcs');
  // Anything unreadable is not silently treated as a weight.
  assert.strictEqual(normalizeUnit('sack'), null);
  assert.strictEqual(allowsFraction('sack'), false);
  assert.strictEqual(allowsFraction('kg'), true);
  assert.strictEqual(allowsFraction('pcs'), false);

  const products = [
    { id: 'rice', name: 'Rice', unit: 'kg' },
    { id: 'phone', name: 'Phone', unit: 'pcs' },
  ];
  const prisma = stub<PrismaService>({
    product: {
      findMany: async ({ where }: any) =>
        products.filter((p) => where.id.in.includes(p.id)),
    },
    stockItem: { upsert: async () => ({}), createMany: async () => ({}) },
    stockMovement: { create: async () => ({}), createMany: async () => ({}) },
    $queryRaw: async () => [
      { storeId: 's1', productId: 'rice', quantity: 10 as any },
    ],
  });
  const inventory = new InventoryService(prisma);
  const line = (productId: string, quantity: number) => ({
    businessId: 'b1',
    storeId: 's1',
    productId,
    type: 'SALE' as any,
    quantity,
  });

  // 0.5 kg of rice is a sale; 0.5 of a phone is a bug.
  await inventory.applyMovement(prisma as any, line('rice', -0.5));
  await assert.rejects(
    inventory.applyMovement(prisma as any, line('phone', -0.5)),
    /whole number/,
    'a discrete product cannot move in fractions',
  );

  // The batch path nets deltas per product before writing, so it has to
  // validate the raw lines: 0.5 + 0.5 of a phone nets to a passing 1.
  await assert.rejects(
    inventory.applyMovementsBatch(prisma as any, [
      line('phone', -0.5),
      line('phone', -0.5),
    ]),
    /whole number/,
    'two fractional lines that net to a whole number are still rejected',
  );
}

/**
 * A part return must leave the sale PARTIALLY_RETURNED, not RETURNED.
 *
 * Quantities are numeric(12,3), so Prisma hands them back as Decimal, and
 * Decimal.valueOf() is a *string* -- `>=` on two of them compares text, where
 * "2" >= "10" is true. That flipped a 2-of-10 return to fully RETURNED, which
 * drops the sale out of every revenue report (they exclude RETURNED) and
 * blocks the remaining 8 from ever being returned. The Decimals here are the
 * point of the check: with plain numbers it passes either way.
 */
async function partReturnLeavesTheSalePartiallyReturned() {
  const dec = (v: string) => new Prisma.Decimal(v);
  const item = {
    id: 'si1',
    productId: 'p1',
    name: 'Rice',
    quantity: dec('10.000'),
    returnedQty: dec('0.000'),
    lineTotal: dec('1000.00'),
  };
  const sale = {
    id: 'sale1',
    businessId: 'b1',
    storeId: 's1',
    customerId: null,
    status: SaleStatus.COMPLETED,
    total: dec('1000.00'),
    amountPaid: dec('1000.00'),
    items: [item],
  };
  let saved: any = null;
  const prisma = stub<PrismaService>({
    sale: { findFirst: async () => sale },
    // nothing on this sale is serialised
    product: { findMany: async () => [] },
    $transaction: async (fn: any) =>
      fn({
        saleItem: {
          findMany: async () => [item],
          // Unguarded, like a plain Prisma increment — see the race check below.
          update: async ({ data }: any) => {
            item.returnedQty = item.returnedQty.plus(data.returnedQty.increment);
            return item;
          },
        },
        // The service bumps returnedQty through a guarded raw UPDATE so a
        // racing return can't over-return a line. Model the guard here:
        // apply it only while it stays within the line quantity, and report
        // the row count the way RETURNING does.
        $queryRaw: async (_sql: any, ...params: any[]) => {
          const delta = new Prisma.Decimal(params[0]);
          if (item.returnedQty.plus(delta).greaterThan(item.quantity)) return [];
          item.returnedQty = item.returnedQty.plus(delta);
          return [{ id: item.id }];
        },
        sale: {
          update: async ({ data }: any) => {
            saved = data;
            return { ...sale, ...data };
          },
        },
        customer: { update: async () => ({}) },
      }),
  });
  const inventory = stub<InventoryService>({
    applyMovementsBatch: async () => undefined,
    returnSerialsToStock: async () => undefined,
  });
  const service = new SalesService(prisma, inventory, stub<MailService>({}));

  const first: any = await service.returnItems(user, 'sale1', {
    items: [{ saleItemId: 'si1', quantity: 2 }],
  } as any);
  assert.strictEqual(first.refund, 200, '2 of 10 units on a 1000 line');
  assert.strictEqual(
    saved.status,
    SaleStatus.PARTIALLY_RETURNED,
    '2 of 10 returned is a part return, not a full one',
  );

  // The remaining 8 must still be returnable, and close the sale out.
  const second: any = await service.returnItems(user, 'sale1', {
    items: [{ saleItemId: 'si1', quantity: 8 }],
  } as any);
  assert.strictEqual(second.refund, 800, 'the rest of the line');
  assert.strictEqual(
    saved.status,
    SaleStatus.RETURNED,
    'every unit back on the shelf closes the sale out',
  );

  // Nothing is left to return. Refused twice over: the snapshot check sees
  // nothing returnable, and behind it the guarded increment would match zero
  // rows anyway -- which is the half that also holds when the competing
  // return lands after this one read the sale.
  await assert.rejects(
    service.returnItems(user, 'sale1', {
      items: [{ saleItemId: 'si1', quantity: 1 }],
    } as any),
    /only 0 left|returned by someone else/,
    'a line cannot be returned past the quantity sold',
  );
}

/**
 * The race the guarded increment exists for: two returns for the last unit of
 * a line, both reading the sale before either commits. The snapshot check
 * passes for both -- it is reading a value that is already stale -- so the
 * only thing standing between them and a double refund (stock back in twice,
 * money out twice) is the `returnedQty + delta <= quantity` test the UPDATE
 * itself applies against the locked row.
 */
async function aStaleReadCannotOverReturnALine() {
  const dec = (v: string) => new Prisma.Decimal(v);
  // What the database actually holds: the competing return already landed.
  const committed = { id: 'si1', returnedQty: dec('1.000'), quantity: dec('1.000') };
  // What this request read a moment earlier, before that happened.
  const stale = {
    id: 'si1',
    productId: 'p1',
    name: 'Rice',
    quantity: dec('1.000'),
    returnedQty: dec('0.000'),
    lineTotal: dec('100.00'),
  };
  const prisma = stub<PrismaService>({
    sale: {
      findFirst: async () => ({
        id: 'sale1',
        businessId: 'b1',
        storeId: 's1',
        customerId: null,
        status: SaleStatus.COMPLETED,
        total: dec('100.00'),
        amountPaid: dec('100.00'),
        items: [stale],
      }),
    },
    product: { findMany: async () => [] },
    $transaction: async (fn: any) =>
      fn({
        saleItem: {
          findMany: async () => [committed],
          // Deliberately present and UNguarded, mirroring what a plain
          // Prisma increment does. If the service ever goes back to this
          // path the race reopens silently, and the assertion below is what
          // notices -- so the stub has to let it happen rather than crash.
          update: async ({ data }: any) => {
            committed.returnedQty = committed.returnedQty.plus(
              data.returnedQty.increment,
            );
            return committed;
          },
        },
        $queryRaw: async (_sql: any, ...params: any[]) => {
          const delta = new Prisma.Decimal(params[0]);
          if (committed.returnedQty.plus(delta).greaterThan(committed.quantity)) {
            return [];
          }
          committed.returnedQty = committed.returnedQty.plus(delta);
          return [{ id: committed.id }];
        },
        sale: { update: async ({ data }: any) => data },
        customer: { update: async () => ({}) },
      }),
  });
  const inventory = stub<InventoryService>({
    applyMovementsBatch: async () => undefined,
    returnSerialsToStock: async () => undefined,
  });
  const service = new SalesService(prisma, inventory, stub<MailService>({}));

  await assert.rejects(
    service.returnItems(user, 'sale1', {
      items: [{ saleItemId: 'si1', quantity: 1 }],
    } as any),
    /returned by someone else/,
    'the guard refuses even though the pre-transaction check passed',
  );
  assert.strictEqual(
    committed.returnedQty.toString(),
    '1',
    'the line is not returned twice',
  );
}

/**
 * The boot-time env gate. JWT_SECRET used to fall back to the literal
 * 'dev-secret', so a deploy that simply forgot the variable came up healthy
 * with every token in the system forgeable. These assert that the ways that
 * can happen are all refused.
 */
function envValidationRefusesUnsafeConfig() {
  const ok = {
    DATABASE_URL: 'postgresql://localhost:5432/db',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGIN: 'https://app.example.com',
    NODE_ENV: 'production',
  };
  assert.doesNotThrow(() => validateEnv({ ...ok }), 'a complete config passes');

  // Dev needs no CORS allowlist -- that fallback is what lets a phone on the
  // LAN reach the API without configuration.
  assert.doesNotThrow(
    () => validateEnv({ ...ok, NODE_ENV: 'development', CORS_ORIGIN: '' }),
    'CORS_ORIGIN is only mandatory in production',
  );
  assert.throws(
    () => validateEnv({ ...ok, CORS_ORIGIN: '' }),
    /CORS_ORIGIN/,
    'production without an allowlist would reflect any origin',
  );

  for (const [label, secret] of [
    ['missing', ''],
    ['the old hardcoded fallback', 'dev-secret'],
    ['the .env.example placeholder', 'change-me-to-a-long-random-string'],
    ['too short to be worth anything', 'short'],
  ] as const) {
    assert.throws(
      () => validateEnv({ ...ok, JWT_SECRET: secret }),
      /JWT_SECRET/,
      `a JWT_SECRET that is ${label} must not boot`,
    );
  }

  assert.throws(
    () => validateEnv({ ...ok, DATABASE_URL: '' }),
    /DATABASE_URL/,
    'no database URL must not boot',
  );

  // The log transport is a local-development convenience that delivers
  // nothing. Reaching production with it set would break verification and
  // password resets invisibly, since both endpoints report success regardless.
  assert.doesNotThrow(
    () => validateEnv({ ...ok, NODE_ENV: 'development', MAIL_TRANSPORT: 'log' }),
    'the log transport is fine in development',
  );
  assert.throws(
    () => validateEnv({ ...ok, MAIL_TRANSPORT: 'log' }),
    /MAIL_TRANSPORT=log/,
    'the log transport must not reach production',
  );
  assert.throws(
    () => validateEnv({ ...ok, MAIL_TRANSPORT: 'smtp' }),
    /MAIL_TRANSPORT/,
    'an unknown transport is a typo, not a silent fallback',
  );

  // The throttle settings are read with Number(). A value that isn't a
  // positive integer becomes NaN there, and a NaN limit turns rate limiting
  // off without saying so -- which is worse than refusing to boot.
  assert.doesNotThrow(
    () => validateEnv({ ...ok, THROTTLE_TTL: '60000', THROTTLE_LIMIT: '120' }),
    'ordinary numeric throttle settings pass',
  );
  assert.doesNotThrow(
    () => validateEnv({ ...ok, THROTTLE_TTL: '', THROTTLE_LIMIT: '' }),
    'unset throttle settings fall back to the defaults in app.module',
  );
  for (const bad of ['0', '-1', 'abc', '60s', '1.5']) {
    assert.throws(
      () => validateEnv({ ...ok, THROTTLE_TTL: bad }),
      /THROTTLE_TTL must be a positive integer/,
      `THROTTLE_TTL="${bad}" must not boot`,
    );
    assert.throws(
      () => validateEnv({ ...ok, THROTTLE_LIMIT: bad }),
      /THROTTLE_LIMIT must be a positive integer/,
      `THROTTLE_LIMIT="${bad}" must not boot`,
    );
  }
}

/**
 * POST /auth/verify-email is @Public(), and it used to check the emailed code
 * only when the account was still unverified -- the check sat inside
 * `if (!user.emailVerified)` while issueToken() ran unconditionally after it.
 * So for any already-verified account the code was never looked at and the
 * endpoint returned a working session to whoever asked, OWNER accounts
 * included; knowing the email address was the entire attack. Both halves are
 * pinned here: the code must be required in every case, and a verified
 * account must fail exactly the way a wrong code does, with no distinguishing
 * message that would turn this into an account-enumeration oracle.
 */
async function verifyEmailAlwaysRequiresTheCode() {
  const TOKEN = 'signed-token';

  const makeService = (
    user: { id: string; emailVerified: boolean } | null,
    liveCodeHash: string | null,
  ) => {
    let consumed = false;
    let markedVerified = false;
    const prisma = stub<PrismaService>({
      user: {
        findUnique: async () =>
          user && {
            ...user,
            businessId: 'b1',
            email: 'owner@example.com',
            name: 'Owner',
            role: 'OWNER',
            tokenVersion: 0,
          },
        update: async () => {
          markedVerified = true;
          return user;
        },
      },
      emailToken: {
        // Mirrors the real consumeCode(): the claim only succeeds when a live
        // token row matches the hash of the code that was sent.
        updateMany: async (args: any) => {
          if (args.data?.consumedAt && liveCodeHash &&
              args.where?.codeHash === liveCodeHash && !consumed) {
            consumed = true;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
    });
    const service = new AuthService(
      prisma,
      stub<JwtService>({ sign: () => TOKEN }),
      stub<MailService>({}),
      stub<AuditService>({ record: async () => undefined }),
      stub<PrincipalCache>({ evict: () => undefined }),
    );
    return { service, verified: () => markedVerified };
  };

  const hashOf = (code: string) =>
    createHash('sha256').update(code).digest('hex');

  // An unverified account with a live code: the happy path still works, and
  // the account is actually flipped to verified.
  const good = makeService({ id: 'u1', emailVerified: false }, hashOf('123456'));
  const result = await good.service.verifyEmail('owner@example.com', '123456');
  assert.strictEqual(result.accessToken, TOKEN, 'the right code still signs in');
  assert.ok(good.verified(), 'the account is marked verified');

  // The bug: a verified account has no outstanding code, so nothing can be
  // claimed -- and that must be refused rather than waved through.
  const already = makeService({ id: 'u1', emailVerified: true }, null);
  await assert.rejects(
    already.service.verifyEmail('owner@example.com', '000000'),
    /Invalid or expired code/,
    'a verified account must not hand out a token for a bogus code',
  );

  // The wrong code against an unverified account, for the comparison that
  // matters: the two failures must be indistinguishable to the caller.
  const wrong = makeService({ id: 'u1', emailVerified: false }, hashOf('123456'));
  const [verifiedErr, wrongErr] = await Promise.all([
    already.service.verifyEmail('owner@example.com', '000000').catch((e) => e),
    wrong.service.verifyEmail('owner@example.com', '999999').catch((e) => e),
  ]);
  assert.strictEqual(
    verifiedErr.message,
    wrongErr.message,
    'a verified account and a wrong code must be indistinguishable',
  );
  assert.strictEqual(
    verifiedErr.getStatus(),
    wrongErr.getStatus(),
    'and must carry the same status code',
  );

  // No account at all: same again, or the endpoint reveals which emails exist.
  const missing = makeService(null, null);
  await assert.rejects(
    missing.service.verifyEmail('nobody@example.com', '123456'),
    /Invalid or expired code/,
    'an unknown address must not be distinguishable either',
  );
}

/**
 * The principal cache must never be the thing that decides a token's fate.
 *
 * It caches the tokenVersion a user had when the entry was written. Right
 * after a password change that value is stale by one, so treating a mismatch
 * as "reject" inverts the whole control: the just-retired token still matches
 * the stale entry and sails through, while the freshly-minted replacement
 * does not and gets a 401. Both of those were observed against the running
 * API before this was fixed. A mismatch must fall through to the database,
 * and AuthService must evict on the way past.
 */
async function principalCacheCannotResurrectARetiredToken() {
  const cache = new PrincipalCache();
  const principal = {
    userId: 'u1',
    businessId: 'b1',
    storeId: 's1',
    role: 'CASHIER' as AuthUser['role'],
    email: 'staff@example.com',
  };

  let dbReads = 0;
  const dbUser = {
    id: 'u1',
    businessId: 'b1',
    storeId: 's1',
    role: 'CASHIER',
    email: 'staff@example.com',
    isActive: true,
    tokenVersion: 1,
    business: { isSuspended: false, isSubscribed: true, subscribedTo: null },
  };
  const prisma = stub<PrismaService>({
    user: {
      findUnique: async () => {
        dbReads++;
        return dbUser;
      },
    },
  });
  const config = stub<ConfigService>({ getOrThrow: () => 'x'.repeat(48) });
  const strategy = new JwtStrategy(config, prisma, cache);

  // First call reads through and caches at version 1.
  await strategy.validate({ sub: 'u1', businessId: 'b1', tv: 1 });
  assert.strictEqual(dbReads, 1);
  // Second call at the same version is served from cache -- the point of it.
  await strategy.validate({ sub: 'u1', businessId: 'b1', tv: 1 });
  assert.strictEqual(dbReads, 1, 'a matching version is served without a read');

  // The password changes: the database moves to 2 and AuthService evicts.
  dbUser.tokenVersion = 2;
  cache.evict('u1');

  // The retired token (tv=1) must be refused against the live value...
  await assert.rejects(
    strategy.validate({ sub: 'u1', businessId: 'b1', tv: 1 }),
    /password was changed/,
    'a token retired by a password change must not be accepted',
  );
  // ...and the replacement (tv=2) must be accepted.
  const ok = await strategy.validate({ sub: 'u1', businessId: 'b1', tv: 2 });
  assert.strictEqual(ok.email, principal.email, 'the new token still works');

  // Even with a stale entry left behind, a newer token must not be rejected
  // on the strength of it -- the mismatch has to fall through to the database.
  cache.set('u1', principal, 1);
  const stillOk = await strategy.validate({ sub: 'u1', businessId: 'b1', tv: 2 });
  assert.strictEqual(
    stillOk.email,
    principal.email,
    'a stale cache entry must not reject a valid newer token',
  );
}

/**
 * Permanent staff deletion is the one irreversible action on the Staff screen,
 * and the schema makes a careless one destructive: Sale.userId and
 * StockMovement.userId are optional (SetNull), so deleting a user who sold
 * things silently blanks out who sold them, while Shift.userId is required and
 * would fail with a raw foreign-key error instead. Both gates are checked here.
 */
async function permanentDeleteRefusesToDestroyHistory() {
  const evicted: string[] = [];
  const principals = stub<PrincipalCache>({ evict: (id: string) => evicted.push(id) });
  let deleted: string | null = null;

  const makeService = (
    target: { id: string; name: string; isActive: boolean } | null,
    counts: { sales: number; shifts: number; movements: number },
  ) =>
    new UsersService(
      stub<PrismaService>({
        user: {
          findFirst: async () => target,
          delete: async (args: any) => {
            deleted = args.where.id;
            return target;
          },
        },
        sale: { count: async () => counts.sales },
        shift: { count: async () => counts.shifts },
        stockMovement: { count: async () => counts.movements },
      }),
      principals,
    );

  const none = { sales: 0, shifts: 0, movements: 0 };

  // You cannot delete yourself, whatever state the account is in.
  await assert.rejects(
    makeService({ id: 'u1', name: 'Me', isActive: false }, none).destroy('b1', 'u1', 'u1'),
    /cannot delete yourself/,
    'self-deletion must be refused',
  );

  // An active account has to be deactivated first -- delete is step two.
  await assert.rejects(
    makeService({ id: 'u2', name: 'Ana', isActive: true }, none).destroy('b1', 'u2', 'u1'),
    /Deactivate this staff member/,
    'an active staff member must not be deleted outright',
  );

  // Another business's user is invisible, so deletion cannot cross the tenant line.
  await assert.rejects(
    makeService(null, none).destroy('b1', 'other', 'u1'),
    /User not found/,
    'deletion must be scoped to the caller\'s business',
  );

  // History of any kind blocks the delete, and the message says what is there.
  for (const [counts, expected] of [
    [{ sales: 42, shifts: 0, movements: 0 }, /42 sales/],
    [{ sales: 0, shifts: 1, movements: 0 }, /1 shift(?!s)/],
    [{ sales: 0, shifts: 0, movements: 7 }, /7 stock movements/],
  ] as const) {
    await assert.rejects(
      makeService({ id: 'u3', name: 'Ana', isActive: false }, counts).destroy('b1', 'u3', 'u1'),
      expected,
      `history (${JSON.stringify(counts)}) must block permanent deletion`,
    );
  }
  assert.strictEqual(deleted, null, 'nothing may be deleted while history exists');

  // The case it is actually for: a deactivated account that never did anything.
  await makeService({ id: 'u4', name: 'Typo', isActive: false }, none).destroy('b1', 'u4', 'u1');
  assert.strictEqual(deleted, 'u4', 'a clean deactivated account is deleted');
  assert.ok(
    evicted.includes('u4'),
    'a deleted user must be evicted from the principal cache, not served from it',
  );
}

/**
 * `User.storeId` used to be only a default: services read it as a fallback and
 * then checked the resulting store against the *business*, never against the
 * caller. A cashier assigned to one branch could name another branch outright
 * -- verified against a running API before this guard existed, where a cashier
 * assigned to Main Store opened a till at a second branch and got a 201.
 */
function staffCannotReachAnotherStore() {
  const guard = new StoreScopeGuard();
  const ctx = (user: unknown, body: unknown = {}, query: unknown = {}) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user, body, query }) }) }) as any;

  const MINE = 'store-a';
  const OTHER = 'store-b';
  const cashier = { userId: 'u1', businessId: 'b1', storeId: MINE, role: 'CASHIER', email: 'c@x' };
  const keeper = { ...cashier, role: 'STOCK_KEEPER' };
  const roaming = { ...cashier, storeId: null };
  const manager = { ...cashier, role: 'MANAGER' };
  const owner = { ...cashier, role: 'OWNER' };

  // Naming another store is refused, wherever the id rides.
  for (const [who, label] of [[cashier, 'cashier'], [keeper, 'stock keeper']] as const) {
    for (const field of ['storeId', 'fromStoreId', 'toStoreId']) {
      assert.throws(
        () => guard.canActivate(ctx(who, { [field]: OTHER })),
        /only work on the store you are assigned to/,
        `a ${label} must not act on another store via body.${field}`,
      );
      assert.throws(
        () => guard.canActivate(ctx(who, {}, { [field]: OTHER })),
        /only work on the store you are assigned to/,
        `a ${label} must not read another store via query.${field}`,
      );
    }
    // Their own store, and naming none at all, stay allowed.
    assert.ok(guard.canActivate(ctx(who, { storeId: MINE })), 'own store is allowed');
    assert.ok(guard.canActivate(ctx(who, {})), 'naming no store is allowed');
    assert.ok(guard.canActivate(ctx(who, { storeId: '' })), 'the empty filter is allowed');
    assert.ok(guard.canActivate(ctx(who, { storeId: null })), 'an explicit null is allowed');
  }


  // A transfer names two stores that must differ, so the two directions are
  // judged separately: you may push stock out of your own branch to anywhere,
  // but you may not pull from a branch you do not stand at.
  assert.ok(
    guard.canActivate(ctx(keeper, { fromStoreId: MINE, toStoreId: OTHER })),
    'a stock keeper may send their own stock to another branch',
  );
  assert.throws(
    () => guard.canActivate(ctx(keeper, { fromStoreId: OTHER, toStoreId: MINE })),
    /only work on the store you are assigned to/,
    'pulling stock out of another branch must still be refused',
  );
  assert.throws(
    () => guard.canActivate(ctx(keeper, { fromStoreId: OTHER, toStoreId: 'store-c' })),
    /only work on the store you are assigned to/,
    'a transfer between two other branches must be refused',
  );
  // The exemption is tied to the source being theirs -- it must not leak into
  // a plain toStoreId on some other kind of request.
  assert.throws(
    () => guard.canActivate(ctx(keeper, { toStoreId: OTHER })),
    /only work on the store you are assigned to/,
    'toStoreId alone, with no outbound source, stays pinned',
  );

  // Management moves between branches; so does staff with nothing assigned.
  for (const [who, label] of [
    [owner, 'owner'], [manager, 'manager'], [roaming, 'unassigned staff'],
  ] as const) {
    assert.ok(
      guard.canActivate(ctx(who, { storeId: OTHER })),
      `${label} must stay free to work across stores`,
    );
  }

  // A @Public route has no principal to pin.
  assert.ok(guard.canActivate(ctx(undefined, { storeId: OTHER })), 'public routes pass');

  // The other half: an *unfiltered* list. The guard has nothing to compare
  // when the field is absent, so pinned staff get scoped rather than shown
  // every branch.
  assert.strictEqual(scopeToStore(cashier as any, undefined), MINE, 'pinned staff are scoped');
  assert.strictEqual(scopeToStore(cashier as any, ''), MINE, '"all stores" still means theirs');
  assert.strictEqual(scopeToStore(keeper as any, MINE), MINE, 'their own filter survives');
  assert.strictEqual(scopeToStore(owner as any, undefined), undefined, 'an owner sees every store');
  assert.strictEqual(scopeToStore(manager as any, OTHER), OTHER, 'a manager may filter freely');
  assert.strictEqual(scopeToStore(roaming as any, undefined), undefined, 'unassigned staff see all');
}

/**
 * Per-store catalogs are encoded as StockItem rows: a store carries a product
 * exactly when a row exists for it. Dropping a store therefore deletes a row,
 * which would take any quantity on it with it -- so a branch still holding
 * stock, batches or serials must block the drop rather than silently write it
 * off. Variants move with their parent.
 */
async function productStoresCannotSilentlyWriteOffStock() {
  const make = (opts: {
    stock: { storeId: string; productId: string; quantity: number }[];
    batches?: { storeId: string }[];
    serials?: { storeId: string | null }[];
    variants?: { id: string }[];
    /** Rows as they are at DELETE time, when a concurrent write changed them. */
    stockAtDelete?: { storeId: string; productId: string; quantity: number }[];
  }) => {
    const deleted: unknown[] = [];
    const created: unknown[] = [];
    const svc = new ProductsService(
      stub<PrismaService>({
        product: {
          findFirst: async () => ({ id: 'p1', name: 'Rice 5kg' }),
          findMany: async () => opts.variants ?? [],
        },
        store: {
          findMany: async (args: any) => {
            const ids: string[] = args?.where?.id?.in ?? ['s1', 's2'];
            return ids.map((id) => ({ id, name: id.toUpperCase() }));
          },
        },
        stockItem: {
          findMany: async () => opts.stock,
          deleteMany: async (a: unknown) => { deleted.push(a); return { count: 1 }; },
          createMany: async (a: unknown) => { created.push(a); return { count: 1 }; },
        },
        batch: { findMany: async () => opts.batches ?? [] },
        serial: { findMany: async () => opts.serials ?? [] },
        $transaction: async (fn: any) =>
          fn({
            stockItem: {
              // The real delete carries `quantity: 0` and is matched against the
              // live row, so the stub matches against `stockAtDelete` when the
              // test is simulating a concurrent write.
              deleteMany: async (a: any) => {
                deleted.push(a);
                const live = opts.stockAtDelete ?? opts.stock;
                const dropping: string[] = a?.where?.storeId?.in ?? [];
                const count = live.filter(
                  (r) => dropping.includes(r.storeId) && Number(r.quantity) === 0,
                ).length;
                return { count };
              },
              createMany: async (a: unknown) => { created.push(a); return { count: 1 }; },
            },
          }),
      }),
    );
    return { svc, deleted, created };
  };

  // A product carried nowhere is invisible everywhere.
  await assert.rejects(
    make({ stock: [] }).svc.setStores('b1', 'p1', []),
    /at least one store/,
    'an empty store list must be refused',
  );

  // Dropping a branch that still holds units.
  await assert.rejects(
    make({ stock: [{ storeId: 's2', productId: 'p1', quantity: 4 }] })
      .svc.setStores('b1', 'p1', ['s1']),
    /still has stock at/,
    'a branch holding quantity must not be dropped',
  );

  // ...or batches, or serials -- each blocks on its own.
  await assert.rejects(
    make({
      stock: [{ storeId: 's2', productId: 'p1', quantity: 0 }],
      batches: [{ storeId: 's2' }],
    }).svc.setStores('b1', 'p1', ['s1']),
    /still has stock at/,
    'a branch holding batches must not be dropped',
  );
  await assert.rejects(
    make({
      stock: [{ storeId: 's2', productId: 'p1', quantity: 0 }],
      serials: [{ storeId: 's2' }],
    }).svc.setStores('b1', 'p1', ['s1']),
    /still has stock at/,
    'a branch holding serials must not be dropped',
  );

  // An unassigned serial pins no store, so it must not block anything.
  const loose = make({
    stock: [{ storeId: 's2', productId: 'p1', quantity: 0 }],
    serials: [{ storeId: null }],
  });
  await loose.svc.setStores('b1', 'p1', ['s1']);
  assert.strictEqual(loose.deleted.length, 1, 'an empty branch is dropped');

  // The pre-flight check reads stock outside the transaction, so it can go
  // stale. If a sale, transfer or receipt lands before the delete, the guard on
  // the delete itself must catch it -- otherwise those units vanish with no
  // StockMovement saying where they went.
  await assert.rejects(
    make({
      stock: [{ storeId: 's2', productId: 'p1', quantity: 0 }],
      stockAtDelete: [{ storeId: 's2', productId: 'p1', quantity: 5 }],
    }).svc.setStores('b1', 'p1', ['s1']),
    /changed stock while its stores were being edited/,
    'stock arriving mid-edit must abort the drop, not be deleted with the row',
  );

  // Variants follow their parent.
  const withVariants = make({
    stock: [{ storeId: 's1', productId: 'p1', quantity: 0 }],
    variants: [{ id: 'v1' }, { id: 'v2' }],
  });
  const res = await withVariants.svc.setStores('b1', 'p1', ['s1', 's2']);
  assert.strictEqual(res.variantsUpdated, 2, 'variants move with the parent');
  const rows = (withVariants.created[0] as any).data as any[];
  assert.ok(
    rows.some((r) => r.productId === 'v1' && r.storeId === 's2'),
    'a newly carried store gets a row for each variant too',
  );
  assert.ok(
    rows.every((r) => Number(r.quantity) === 0),
    'a newly carried store starts at zero, never inheriting a quantity',
  );
}

/**
 * A password reset by an owner has to kill the target's sessions as hard as a
 * self-service change does. It did not: AuthService bumped tokenVersion and
 * evicted, UsersService.update only rewrote the hash -- so an owner resetting
 * a departing employee's password left that employee's token working for the
 * rest of JWT_EXPIRES_IN, up to seven days past the reset meant to lock them
 * out.
 */
async function anAdminPasswordResetEndsTheirSessions() {
  const evicted: string[] = [];
  const target = { id: 'u2', role: UserRole.CASHIER, businessId: 'b1', isActive: true };
  let written: any = null;

  const makeService = () =>
    new UsersService(
      stub<PrismaService>({
        user: {
          findFirst: async () => target,
          findUnique: async () => null,
          update: async (args: any) => {
            written = args.data;
            return { id: target.id };
          },
        },
        store: { findFirst: async () => ({ id: 's1' }) },
      }),
      stub<PrincipalCache>({ evict: (id: string) => evicted.push(id) }),
    );

  // An owner resetting someone else's password.
  await makeService().update('b1', 'u2', { password: 'newpassword1' }, UserRole.OWNER, 'u1');
  assert.ok(written.passwordHash, 'the new password is hashed');
  assert.deepStrictEqual(
    written.tokenVersion,
    { increment: 1 },
    'the reset must retire every token minted under the old password',
  );
  assert.ok(evicted.includes('u2'), 'the cached principal must go with it');

  // A plain rename touches neither, but still drops the cache -- the entry
  // carries the role and active flag an edit may have just changed.
  evicted.length = 0;
  await makeService().update('b1', 'u2', { name: 'Renamed' }, UserRole.OWNER, 'u1');
  assert.strictEqual(written.tokenVersion, undefined, 'a rename retires no tokens');
  assert.ok(evicted.includes('u2'), 'any edit drops the cached principal');

  // Resetting your *own* password here would sign you out mid-edit with no
  // replacement token; AuthService.changePassword is the flow that does it
  // properly, so this one refuses.
  await assert.rejects(
    makeService().update('b1', 'u1', { password: 'newpassword1' }, UserRole.OWNER, 'u1'),
    /Change password/,
    'self password change must be sent to the flow that returns a fresh token',
  );

  // Deactivating must drop the cache too: JwtStrategy refuses an inactive
  // user, but only once it gets past the cache.
  evicted.length = 0;
  await makeService().remove('b1', 'u2', 'u1');
  assert.ok(evicted.includes('u2'), 'a deactivated user must not be served from cache');
}

/**
 * ProductsService seeds a new product into every existing store. The mirror
 * image was missing: a new store inherited nothing, so a branch opened with an
 * empty catalog and every product had to be added back one dialog at a time.
 */
async function aNewStoreOpensCarryingTheCatalog() {
  let created: any = null;
  const svc = new StoresService(
    stub<PrismaService>({
      // create() opens a store and seeds its catalog in one transaction, so
      // the delegates live on the tx handed to the callback.
      $transaction: async (fn: any) =>
        fn({
          store: { create: async () => ({ id: 's2', businessId: 'b1', name: 'Branch' }) },
          product: {
            findMany: async () => [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
          },
          stockItem: {
            createMany: async (args: any) => {
              created = args.data;
              return { count: args.data.length };
            },
          },
        }),
    }),
  );

  const store = await svc.create('b1', { name: 'Branch' } as any);
  assert.strictEqual(store.id, 's2');
  assert.strictEqual(created.length, 3, 'every existing product reaches the new store');
  assert.ok(
    created.every((r: any) => r.storeId === 's2' && r.businessId === 'b1'),
    'the rows belong to the new store and its business',
  );
  assert.ok(
    created.every((r: any) => Number(r.quantity) === 0),
    'a new branch starts at zero -- seeding must never invent stock',
  );

  // A business with no products yet must not blow up on an empty createMany.
  let touched = false;
  const empty = new StoresService(
    stub<PrismaService>({
      $transaction: async (fn: any) =>
        fn({
          store: { create: async () => ({ id: 's3' }) },
          product: { findMany: async () => [] },
          stockItem: { createMany: async () => { touched = true; return { count: 0 }; } },
        }),
    }),
  );
  await empty.create('b1', { name: 'First' } as any);
  assert.strictEqual(touched, false, 'no products means no seeding call at all');
}

/**
 * Manual subscriptions: what the admin panel labels a business, and what a
 * recorded payment does to its paid-until date. Getting this wrong either
 * locks out a shop that paid or gives away months for free.
 */
function subscriptionRules() {
  const now = new Date('2026-09-19T09:00:00Z');
  const inDays = (d: number) => new Date(now.getTime() + d * DAY_MS);

  // Labels, in priority order.
  assert.strictEqual(subscriptionStatus({ isSubscribed: false, subscribedTo: inDays(30) }, 3, now), 'inactive');
  assert.strictEqual(subscriptionStatus({ isSubscribed: true, subscribedTo: inDays(-1) }, 3, now), 'expired');
  assert.strictEqual(subscriptionStatus({ isSubscribed: true, subscribedTo: inDays(2) }, 0, now), 'trial', 'never paid + end date = trial, even when ending soon');
  assert.strictEqual(subscriptionStatus({ isSubscribed: true, subscribedTo: inDays(5) }, 1, now), 'expiring');
  assert.strictEqual(subscriptionStatus({ isSubscribed: true, subscribedTo: inDays(40) }, 1, now), 'active');
  assert.strictEqual(subscriptionStatus({ isSubscribed: true, subscribedTo: null }, 0, now), 'active', 'no end date never expires');

  // Calendar months clamp to the month's end instead of spilling over.
  assert.strictEqual(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.strictEqual(addMonths(new Date('2026-11-15T00:00:00Z'), 3).toISOString().slice(0, 10), '2027-02-15');

  // Paying early continues from the current end date, so no days are lost.
  const early = paymentPeriod({ now, currentEnd: inDays(10), months: 1 });
  assert.strictEqual(early.from.getTime(), inDays(10).getTime());
  assert.strictEqual(early.newEnd.getTime(), addMonths(inDays(10), 1).getTime());
  // Paying after it lapsed starts today.
  const late = paymentPeriod({ now, currentEnd: inDays(-20), months: 1 });
  assert.strictEqual(late.from.getTime(), now.getTime());
  // Recording an old, shorter payment never cuts a longer subscription back.
  const old = paymentPeriod({ now, currentEnd: inDays(300), periodFrom: inDays(-60), periodTo: inDays(-30) });
  assert.strictEqual(old.newEnd.getTime(), inDays(300).getTime());
  assert.throws(() => paymentPeriod({ now, currentEnd: null }), /either months or periodTo/);
  assert.throws(() => paymentPeriod({ now, currentEnd: null, months: 1, periodTo: inDays(9) }), /either months or periodTo/);
  assert.throws(() => paymentPeriod({ now, currentEnd: null, periodTo: inDays(-1) }), /must end after/);

  // Run once a day, every reminder threshold is hit exactly once.
  const end = new Date('2026-10-01T00:00:00Z');
  const seen = Array.from({ length: 10 }, (_, i) =>
    daysUntil(end, new Date(end.getTime() - (8 - i) * DAY_MS + 9 * 3600 * 1000)),
  );
  assert.deepStrictEqual(seen, [8, 7, 6, 5, 4, 3, 2, 1, 0, -1]);

  const trial = trialEndsAt(now);
  assert.strictEqual(trial.getTime() - now.getTime(), 14 * DAY_MS, 'default trial is 14 days');
}

/** The admin panel must never be able to lock every admin out. */
async function adminCannotLockOutThePanel() {
  const admins = [
    { id: 'a1', email: 'a1@x.com', isActive: true },
    { id: 'a2', email: 'a2@x.com', isActive: true },
  ];
  const prisma = stub<PrismaService>({
    platformAdmin: {
      findUnique: async ({ where }: any) => admins.find((a) => a.id === where.id) ?? null,
      count: async ({ where }: any) =>
        admins.filter((a) => a.isActive && a.id !== where.id.not).length,
      update: async ({ where, data }: any) => Object.assign(admins.find((a) => a.id === where.id)!, data),
    },
  });
  const audit = stub<PlatformAuditService>({ record: async () => {} });
  const service = new PlatformAdminsService(prisma, audit);
  const me = { adminId: 'a1', email: 'a1@x.com' };

  await assert.rejects(service.update(me, 'a1', { isActive: false }), /deactivate yourself/);
  await service.update(me, 'a2', { isActive: false }); // another admin: fine
  // a1 is now the only active admin; a2 (inactive) can't take them out either.
  await assert.rejects(
    service.update({ adminId: 'a2', email: 'a2@x.com' }, 'a1', { isActive: false }),
    /must stay active/,
  );
}

/** A restarted server or a second run the same day must not email twice. */
async function reminderGoesOutOncePerThreshold() {
  const keys = new Set<string>();
  const emails: string[] = [];
  const prisma = stub<PrismaService>({
    notification: {
      create: async ({ data }: any) => {
        if (data.dedupeKey && keys.has(data.dedupeKey)) {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        }
        if (data.dedupeKey) keys.add(data.dedupeKey);
        return data;
      },
    },
    user: { findMany: async () => [{ email: 'owner@shop.com', name: 'Owner' }] },
  });
  const mail = stub<MailService>({
    sendSubscriptionReminder: async (to: string) => {
      emails.push(to);
    },
  });
  const reminders = new SubscriptionRemindersService(prisma, mail);
  const shop = { id: 'b1', name: 'Shop', subscribedTo: new Date('2026-10-01T00:00:00Z') };

  assert.deepStrictEqual(await reminders.remind(shop, 3), { alreadySent: false, emailed: 1, failed: 0 });
  assert.strictEqual((await reminders.remind(shop, 3)).alreadySent, true, 'same threshold again is skipped');
  await reminders.remind(shop, 1); // the next threshold is new
  await reminders.remind(shop, 1, true); // "send now" always sends
  assert.strictEqual(emails.length, 3);
}

async function main() {
  subscriptionRules();
  await adminCannotLockOutThePanel();
  await reminderGoesOutOncePerThreshold();
  await shiftReportBalancesTheDrawer();
  await stockTakePreviewComputesVariances();
  await reorderSuggestionsGroupBySupplier();
  await variantGenerationCoversEveryCombination();
  await serialRulesGuardEveryUnit();
  await unitsGovernFractionalQuantities();
  await partReturnLeavesTheSalePartiallyReturned();
  await aStaleReadCannotOverReturnALine();
  await verifyEmailAlwaysRequiresTheCode();
  envValidationRefusesUnsafeConfig();
  await principalCacheCannotResurrectARetiredToken();
  await permanentDeleteRefusesToDestroyHistory();
  staffCannotReachAnotherStore();
  await productStoresCannotSilentlyWriteOffStock();
  await anAdminPasswordResetEndsTheirSessions();
  await aNewStoreOpensCarryingTheCatalog();
  console.log('checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
