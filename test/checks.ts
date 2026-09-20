/**
 * Money/quantity self-checks. No framework: `npm run check` (ts-node).
 *
 * These cover the arithmetic a silent bug would cost a real shop money on --
 * drawer reconciliation and physical counts -- by driving the real services
 * with a stub Prisma client. Everything else needs a database and belongs in
 * an integration suite.
 */
import assert from 'assert';
import { PaymentMethod, Prisma } from '@prisma/client';
import { ShiftsService } from '../src/shifts/shifts.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { ProductsService } from '../src/products/products.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/common/types/auth-user';
import { allowsFraction, normalizeUnit } from '../src/common/units';
import {
  DAY_MS,
  addMonths,
  daysUntil,
  paymentPeriod,
  subscriptionStatus,
  trialEndsAt,
} from '../src/common/subscription';
import { MailService } from '../src/mail/mail.service';
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
  console.log('checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
