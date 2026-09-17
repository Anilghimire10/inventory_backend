/**
 * Money/quantity self-checks. No framework: `npm run check` (ts-node).
 *
 * These cover the arithmetic a silent bug would cost a real shop money on --
 * drawer reconciliation and physical counts -- by driving the real services
 * with a stub Prisma client. Everything else needs a database and belongs in
 * an integration suite.
 */
import assert from 'assert';
import { PaymentMethod, Prisma, SaleStatus } from '@prisma/client';
import { ShiftsService } from '../src/shifts/shifts.service';
import { SalesService } from '../src/sales/sales.service';
import { MailService } from '../src/mail/mail.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { ProductsService } from '../src/products/products.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/common/types/auth-user';
import { allowsFraction, normalizeUnit } from '../src/common/units';
import { validateEnv } from '../src/common/env.validation';
import { PrincipalCache } from '../src/common/principal-cache';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { ConfigService } from '@nestjs/config';

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
    stockItem: { findMany: async () => stock },
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
    store: { findMany: async () => [{ id: 's1' }, { id: 's2' }] },
    stockItem: { createMany: async () => ({ count: 4 }) },
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

async function main() {
  await shiftReportBalancesTheDrawer();
  await stockTakePreviewComputesVariances();
  await reorderSuggestionsGroupBySupplier();
  await variantGenerationCoversEveryCombination();
  await serialRulesGuardEveryUnit();
  await unitsGovernFractionalQuantities();
  await partReturnLeavesTheSalePartiallyReturned();
  await aStaleReadCannotOverReturnALine();
  envValidationRefusesUnsafeConfig();
  await principalCacheCannotResurrectARetiredToken();
  console.log('checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
