/**
 * Money/quantity self-checks. No framework: `npm run check` (ts-node).
 *
 * These cover the arithmetic a silent bug would cost a real shop money on --
 * drawer reconciliation and physical counts -- by driving the real services
 * with a stub Prisma client. Everything else needs a database and belongs in
 * an integration suite.
 */
import assert from 'assert';
import { PaymentMethod } from '@prisma/client';
import { ShiftsService } from '../src/shifts/shifts.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/common/types/auth-user';

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

async function main() {
  await shiftReportBalancesTheDrawer();
  await stockTakePreviewComputesVariances();
  console.log('checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
