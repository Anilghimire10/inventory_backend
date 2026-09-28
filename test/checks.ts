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
import { PaymentMethod, PlatformRole, Prisma, SaleStatus, UserRole } from '@prisma/client';
import { ShiftsService } from '../src/shifts/shifts.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PlatformBillingService, formatReceiptNo } from '../src/platform/platform-billing.service';
import { PlatformService } from '../src/platform/platform.service';
import { PlatformAnnouncementsService, audienceWhere } from '../src/platform/platform-announcements.service';
import { SalesService } from '../src/sales/sales.service';
import { CustomersService } from '../src/customers/customers.service';
import { PaymentsService } from '../src/payments/payments.service';
import { CategoriesService } from '../src/categories/categories.service';
import { MailService } from '../src/mail/mail.service';
import { AuthService } from '../src/auth/auth.service';
import { AuditService } from '../src/audit/audit.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PurchasesService } from '../src/purchases/purchases.service';
import { ProductsService } from '../src/products/products.service';
import { UsersService } from '../src/users/users.service';
import { StoreScopeGuard } from '../src/common/guards/store-scope.guard';
import { assertOwnStore, scopeToStore } from '../src/common/store-scope';
import { StoresService } from '../src/stores/stores.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthUser } from '../src/common/types/auth-user';
import { allowsFraction, normalizeUnit } from '../src/common/units';
import { splitTax } from '../src/common/tax';
import { SettingsService } from '../src/settings/settings.service';
import { ReportsService } from '../src/reports/reports.service';
import { TaxesService } from '../src/taxes/taxes.service';
import { LogRetentionCron } from '../src/settings/log-retention.cron';
import { SupportService } from '../src/support/support.service';
import { QueryTicketsDto } from '../src/support/dto/support.dto';
import { platformRoleAllows } from '../src/platform/platform-auth.guard';
import { platformJwtSecret, validateEnv } from '../src/common/env.validation';
import { sniffImage } from '../src/products/product-image.storage';
import { multerErrorToHttp } from '../src/products/multer-error.filter';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCustomerDto } from '../src/customers/customers.controller';
import { CreateSaleDto } from '../src/sales/dto/create-sale.dto';
import { QueryProductDto } from '../src/products/dto/query-product.dto';
import { PrincipalCache } from '../src/common/principal-cache';
import { isLocalSlot } from '../src/common/timezone';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { ConfigService } from '@nestjs/config';
import {
  DAY_MS,
  addMonths,
  daysUntil,
  isSubscriptionActive,
  paymentPeriod,
  SubscriptionInactiveException,
  subscriptionStatus,
  subscriptionSummary,
  trialEndsAt,
} from '../src/common/subscription';
import { PlatformAdminsService } from '../src/platform/platform-admins.service';
import { ImpersonationReadOnlyGuard } from '../src/common/guards/impersonation-read-only.guard';
import { ForbiddenException } from '@nestjs/common';
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  otpauthUrl,
  totpCode,
  verifyTotp,
} from '../src/common/totp';
import { PlatformAuditService } from '../src/platform/platform-audit.service';
import { PlatformAuthService } from '../src/platform/platform-auth.service';
import { BusinessController } from '../src/business/business.controller';
import { BusinessService } from '../src/business/business.service';
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
  const pay = (method: PaymentMethod, amount: number) => [{ method, amount }];
  const sales = [
    // paid in full, cash -> 1000 in the drawer
    { discount: 0, tax: 0, total: 1000, refundedTotal: 0, amountPaid: 1000, paymentMethod: PaymentMethod.CASH, payments: pay(PaymentMethod.CASH, 1000) },
    // card sale -> revenue, but no cash in the drawer
    { discount: 0, tax: 0, total: 500, refundedTotal: 0, amountPaid: 500, paymentMethod: PaymentMethod.CARD, payments: pay(PaymentMethod.CARD, 500) },
    // 150 paid now BY CARD, 250 on credit. The sale says MIXED, which used to
    // be counted as cash -- the drawer then expected 150 that went to the card.
    { discount: 0, tax: 0, total: 400, refundedTotal: 0, amountPaid: 150, paymentMethod: PaymentMethod.MIXED, payments: pay(PaymentMethod.CARD, 150) },
    // the same split from before the ledger: no payment row, so the old rule
    // (MIXED's paid part is cash) still applies
    { discount: 0, tax: 0, total: 400, refundedTotal: 0, amountPaid: 150, paymentMethod: PaymentMethod.MIXED, payments: [] },
    // cash sale with one of two units returned
    { discount: 0, tax: 0, total: 600, refundedTotal: 300, amountPaid: 600, paymentMethod: PaymentMethod.CASH, payments: pay(PaymentMethod.CASH, 600) },
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
    refundsAtClose: null,
    carriedFloat: null,
    cashLeft: null,
    business: { shiftBlindClose: false, shiftVarianceNoteOver: null },
    cashMovements: [],
  };
  const db: any = {
    shift: {
      findFirst: async () => shift,
      updateMany: async () => ({ count: shift.closedAt ? 0 : 1 }),
      update: async (args: any) => Object.assign(shift, args.data),
    },
    sale: { findMany: async () => sales },
    cashMovement: { findMany: async () => [] },
  };
  db.$transaction = (fn: (tx: unknown) => unknown) => fn(db);
  const prisma = stub<PrismaService>(db);
  const service = new ShiftsService(
    prisma,
    stub<PaymentsService>({
      cashCollectedOnShift: async () => 0,
      // What the refund rows say left this drawer: the 300 above.
      cashRefundedOnShift: async () => 300,
    }),
  );

  const x: any = await service.report('b1', 'sh1');
  assert.strictEqual(x.gross, 2900, 'gross is every stamped sale at full value');
  assert.strictEqual(x.refunds, 300, 'refunds are what was handed back on these sales');
  assert.strictEqual(x.net, 2600, 'net = gross - refunds');
  // 5000 float + 1000 cash + 150 legacy cash part + 600 cash - 300 cash refund
  assert.strictEqual(x.expectedCash, 6450, 'card and credit money never touches the drawer');
  assert.strictEqual(x.cashIn, 1750, 'a card part-payment is not cash');
  assert.strictEqual(
    x.byTender.find((t: any) => t.method === PaymentMethod.CARD).amount,
    500,
    'tender split keeps card separate',
  );

  const closed: any = await service.close(user, 'sh1', { countedCash: 6400 });
  assert.strictEqual(closed.variance, -50, 'counted short of expected is a negative variance');
  assert.strictEqual(closed.expectedCash, 6450, 'close snapshots what it computed');

  // Days later the rest of the 600 sale comes back. The Z report was counted
  // and signed off at close; it must still read what it read then.
  sales[4].refundedTotal = 600;
  const later: any = await service.report('b1', 'sh1');
  assert.strictEqual(later.refunds, 300, 'refunds are frozen at close');
  assert.strictEqual(later.net, 2600, 'and so is net');
}

/**
 * Cash control on a shift: pay ins and pay outs move the expected cash, blind
 * close hides it from cashiers only, a big variance needs a note (except when
 * the cashier couldn't have known), a count by denomination must add up, and
 * the next shift opens against what this one left behind.
 */
async function cashControlOnAShift() {
  const owner: AuthUser = { ...user, userId: 'owner1', role: 'OWNER' as AuthUser['role'] };

  const build = (settings: { shiftBlindClose: boolean; shiftVarianceNoteOver: number | null }) => {
    const shift: any = {
      id: 'sh1',
      businessId: 'b1',
      storeId: 's1',
      userId: 'u1',
      openedAt: new Date(),
      closedAt: null,
      openingFloat: 1000,
      expectedCash: null,
      countedCash: null,
      variance: null,
      refundsAtClose: null,
      carriedFloat: null,
      cashLeft: null,
      business: {
        shiftBlindClose: settings.shiftBlindClose,
        shiftVarianceNoteOver:
          settings.shiftVarianceNoteOver === null
            ? null
            : new Prisma.Decimal(settings.shiftVarianceNoteOver),
      },
      cashMovements: [],
    };
    const movements = [
      { type: 'PAY_OUT', amount: 300 }, // tea and milk
      { type: 'PAY_IN', amount: 500 }, // more change
    ];
    const created: any[] = [];
    const db: any = {
      shift: {
        findFirst: async () => shift,
        updateMany: async () => ({ count: shift.closedAt ? 0 : 1 }),
        update: async (args: any) => Object.assign(shift, args.data),
      },
      sale: {
        findMany: async () => [
          { discount: 0, tax: 0, total: 2000, refundedTotal: 0, amountPaid: 2000, paymentMethod: PaymentMethod.CASH, payments: [{ method: PaymentMethod.CASH, amount: 2000 }] },
        ],
      },
      cashMovement: {
        findMany: async () => movements,
        create: async (args: any) => {
          created.push(args.data);
          return { id: 'cm1', ...args.data, user: { id: args.data.userId, name: 'x' } };
        },
      },
    };
    db.$transaction = (fn: (tx: unknown) => unknown) => fn(db);
    const service = new ShiftsService(
      stub<PrismaService>(db),
      stub<PaymentsService>({
        cashCollectedOnShift: async () => 0,
        cashRefundedOnShift: async () => 0,
      }),
    );
    return { service, shift, created };
  };

  // 1000 float + 2000 cash sale - 300 paid out + 500 paid in
  {
    const { service } = build({ shiftBlindClose: false, shiftVarianceNoteOver: null });
    const x: any = await service.report('b1', 'sh1', user);
    assert.strictEqual(x.expectedCash, 3200, 'pay ins add to the drawer, pay outs take from it');
    assert.strictEqual(x.payIns, 500);
    assert.strictEqual(x.payOuts, 300);
    assert.strictEqual(x.blindClose, false);
  }

  // Blind close: the cashier sees none of it, the owner sees all of it.
  {
    const { service } = build({ shiftBlindClose: true, shiftVarianceNoteOver: null });
    const cashierView: any = await service.report('b1', 'sh1', user);
    assert.strictEqual(cashierView.blindClose, true);
    assert.strictEqual(cashierView.expectedCash, null, 'a blind cashier is not told what to count');
    assert.strictEqual(cashierView.cashIn, null);
    assert.deepStrictEqual(cashierView.byTender, [], 'cash by tender would give the expected figure away');
    const ownerView: any = await service.report('b1', 'sh1', owner);
    assert.strictEqual(ownerView.expectedCash, 3200, 'management always sees the figures');
  }

  // Short by 200 with notes required over 100: refused without a note.
  {
    const { service, shift } = build({ shiftBlindClose: false, shiftVarianceNoteOver: 100 });
    await assert.rejects(
      service.close(user, 'sh1', { countedCash: 3000 }),
      /short by 200\.00/,
      'a big variance needs a reason',
    );
    assert.strictEqual(shift.closedAt, null, 'and the refused close changed nothing');
    await assert.rejects(
      service.close(user, 'sh1', { countedCash: 3000, note: '   ' }),
      /Add a note/,
      'whitespace is not a reason',
    );
    const closed: any = await service.close(user, 'sh1', { countedCash: 3000, note: 'gave wrong change' });
    assert.strictEqual(closed.variance, -200);
    // Within the limit needs nothing.
    const small = build({ shiftBlindClose: false, shiftVarianceNoteOver: 100 });
    await small.service.close(user, 'sh1', { countedCash: 3150 });
    assert.ok(small.shift.closedAt, 'short by 50 closes without a note');
  }

  // Blind: refusing would tell the cashier they are off, so it goes through.
  {
    const { service, shift } = build({ shiftBlindClose: true, shiftVarianceNoteOver: 100 });
    const closed: any = await service.close(user, 'sh1', { countedCash: 3000 });
    assert.ok(shift.closedAt, 'a blind cashier is never refused on variance');
    assert.strictEqual(shift.variance, -200, 'the variance is still recorded');
    assert.strictEqual(closed.variance, null, 'but not shown to them');
  }

  // Cash left for the next shift, and counting by denomination.
  {
    const { service, shift } = build({ shiftBlindClose: false, shiftVarianceNoteOver: null });
    await assert.rejects(
      service.close(user, 'sh1', { countedCash: 3200, cashLeft: 5000 }),
      /can’t be more than the cash counted/,
    );
    await assert.rejects(
      service.close(user, 'sh1', { countedCash: 3200, cashCount: { '1000': 3 } }),
      /add up to 3000\.00, not the 3200\.00/,
      'a breakdown that disagrees with the total is refused',
    );
    await assert.rejects(
      service.close(user, 'sh1', { countedCash: 3200, cashCount: { '100': 2.5 } }),
      /whole number/,
    );
    await service.close(user, 'sh1', {
      countedCash: 3200,
      cashLeft: 1000,
      cashCount: { '1000': 3, '100': 2, '5': 0 },
    });
    assert.deepStrictEqual(shift.cashCount, { '1000': 3, '100': 2 }, 'zero lines are dropped');
    assert.strictEqual(shift.cashLeft, 1000);
  }

  // Pay in / pay out rules.
  {
    const { service, shift, created } = build({ shiftBlindClose: false, shiftVarianceNoteOver: null });
    await assert.rejects(
      service.addMovement(user, 'sh1', { type: 'PAY_IN' as any, reason: 'EXPENSE' as any, amount: 50 }),
      /isn’t a reason for a pay in/,
      'an expense is never cash coming in',
    );
    await assert.rejects(
      service.addMovement(user, 'sh1', { type: 'PAY_OUT' as any, reason: 'OTHER' as any, amount: 50 }),
      /Add a note/,
      'OTHER has to say what it was',
    );
    const m: any = await service.addMovement(user, 'sh1', {
      type: 'PAY_OUT' as any,
      reason: 'SUPPLIER' as any,
      amount: 1200,
      note: ' milk supplier ',
    });
    assert.strictEqual(m.amount, 1200);
    assert.strictEqual(created[0].userId, 'u1', 'recorded against who did it');
    assert.strictEqual(created[0].note, 'milk supplier');

    shift.closedAt = new Date();
    await assert.rejects(
      service.addMovement(user, 'sh1', { type: 'PAY_IN' as any, reason: 'FLOAT_TOPUP' as any, amount: 50 }),
      /closed/,
      'a counted drawer is final',
    );
  }

  // The next shift opens against what the last one left in the drawer.
  {
    let createdShift: any = null;
    const service = new ShiftsService(
      stub<PrismaService>({
        store: { findFirst: async () => ({ id: 's1' }) },
        shift: {
          // Nothing open at the store; the last close left 1500.
          findFirst: async (args: any) =>
            args.where.closedAt === null
              ? null
              : { cashLeft: new Prisma.Decimal(1500), closedAt: new Date(), user: { name: 'Ramesh' } },
          create: async (args: any) => (createdShift = args.data),
        },
      }),
      stub<PaymentsService>({}),
    );
    const suggested = await service.suggestedFloat(user, 's1');
    assert.strictEqual(suggested?.amount, 1500);
    assert.strictEqual(suggested?.closedBy, 'Ramesh');
    await service.open(user, { storeId: 's1', openingFloat: 1400 });
    assert.strictEqual(createdShift.carriedFloat, 1500, 'the 100 missing overnight is on record');
    assert.strictEqual(createdShift.openingFloat, 1400);
  }
}

/**
 * One drawer, one shift. An owner at a store where a till is running joins it
 * rather than opening a second one by habit -- unless they say the counter
 * has its own cash. The Z report then says whose sales are in the drawer.
 */
async function oneDrawerOneShift() {
  const owner: AuthUser = { ...user, userId: 'owner1', role: 'OWNER' as AuthUser['role'] };
  const cashier: AuthUser = { ...user, userId: 'u2', role: 'CASHIER' as AuthUser['role'] };

  // `open` is every shift open at store s1.
  const build = (open: { id: string; userId: string; name: string }[]) => {
    const created: any[] = [];
    const service = new ShiftsService(
      stub<PrismaService>({
        store: { findFirst: async () => ({ id: 's1' }) },
        shift: {
          findFirst: async (args: any) => {
            if (args.where.closedAt !== null) return null; // no previous close
            const hit = open.find((sh) => !args.where.userId || sh.userId === args.where.userId);
            return hit ? { ...hit, user: { name: hit.name } } : null;
          },
          create: async (args: any) => {
            created.push(args.data);
            return { id: 'new', ...args.data };
          },
        },
      }),
      stub<PaymentsService>({}),
    );
    return { service, created };
  };
  const sangu = { id: 'sh-sangu', userId: 'u2', name: 'Sangu' };

  {
    const { service, created } = build([sangu]);
    await assert.rejects(
      service.open(owner, { storeId: 's1', openingFloat: 1200 }),
      (e: any) => e.getStatus() === 409 && /Sangu’s till is already open/.test(e.message),
      'an owner is sent to the open till, not given a second drawer',
    );
    assert.strictEqual(created.length, 0);
    await service.open(owner, { storeId: 's1', openingFloat: 500, separateDrawer: true });
    assert.strictEqual(created[0].userId, 'owner1', 'unless the counter really has its own cash');
  }

  {
    const mine = { id: 'sh-mine', userId: 'owner1', name: 'Owner' };
    const { service, created } = build([sangu, mine]);
    const got: any = await service.open(owner, { storeId: 's1', openingFloat: 1 });
    assert.strictEqual(got.id, 'sh-mine', 'an owner with their own till open here resumes it');
    assert.strictEqual(created.length, 0);
  }

  {
    const ownerTill = { id: 'sh-owner', userId: 'owner1', name: 'Owner' };
    const { service, created } = build([ownerTill]);
    await service.open(cashier, { storeId: 's1', openingFloat: 1000 });
    assert.strictEqual(created[0].userId, 'u2', 'a cashier, who cannot join, is never blocked');
  }

  // Whose sales are in the drawer.
  const sale = (userId: string, name: string, total: number) => ({
    discount: 0, tax: 0, total, refundedTotal: 0, amountPaid: total,
    paymentMethod: PaymentMethod.CASH, userId, user: { name },
    payments: [{ method: PaymentMethod.CASH, amount: total }],
  });
  const db: any = {
    shift: {
      findFirst: async () => ({
        id: 'sh-sangu', businessId: 'b1', userId: 'u2', openedAt: new Date(), closedAt: null,
        openingFloat: 1000, expectedCash: null, countedCash: null, variance: null,
        refundsAtClose: null, carriedFloat: null, cashLeft: null,
        business: { shiftBlindClose: false, shiftVarianceNoteOver: null }, cashMovements: [],
      }),
    },
    sale: {
      findMany: async () => [
        sale('u2', 'Sangu', 300), sale('owner1', 'Owner', 900), sale('u2', 'Sangu', 200),
      ],
    },
    cashMovement: { findMany: async () => [] },
  };
  const report: any = await new ShiftsService(
    stub<PrismaService>(db),
    stub<PaymentsService>({ cashCollectedOnShift: async () => 0, cashRefundedOnShift: async () => 0 }),
  ).report('b1', 'sh-sangu', owner);
  assert.deepStrictEqual(
    report.byUser.map((u: any) => [u.name, u.count, u.amount]),
    [['Owner', 1, 900], ['Sangu', 2, 500]],
    'sales split by who rang them, biggest first',
  );
  assert.strictEqual(report.expectedCash, 2400, 'and all of it is in the one drawer');
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
  const service = new PurchasesService(
    prisma,
    new InventoryService(prisma),
    stub<PaymentsService>({ record: async () => undefined }),
  );

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
 * A sale, its lines and everything a return touches, for driving
 * SalesService.returnItems the way the database would: the sale lock, the
 * guarded returnedQty bump, the customer's balance and the refund rows.
 * Amounts are plain numbers in, Decimals inside -- Prisma's own types, which
 * is what caught the string-comparison bug below.
 */
function returnHarness(opts: {
  sale: {
    subtotal: number;
    tax?: number;
    discount?: number;
    total: number;
    amountPaid: number;
    paymentMethod?: PaymentMethod;
    customerId?: string | null;
    status?: SaleStatus;
  };
  items: { id: string; quantity: number; lineTotal: number }[];
  /** The customer's stored credit balance, when the sale has a customer. */
  customerBalance?: number;
  /** Tender on the sale's SALE payment row; null for a sale with none. */
  salePaymentMethod?: PaymentMethod | null;
  /** The till the returner is on, as ShiftsService resolves it. */
  shiftId?: string | null;
  /** Lines whose product is batch-tracked. */
  batchTracked?: string[];
}) {
  const dec = (v: number) => new Prisma.Decimal(v);
  const items = opts.items.map((i) => ({
    id: i.id,
    productId: `p-${i.id}`,
    name: i.id,
    quantity: dec(i.quantity),
    returnedQty: dec(0),
    lineTotal: dec(i.lineTotal),
  }));
  const sale: any = {
    id: 'sale1',
    businessId: 'b1',
    storeId: 's1',
    shiftId: 'sh-sold',
    customerId: opts.sale.customerId ?? null,
    status: opts.sale.status ?? SaleStatus.COMPLETED,
    paymentMethod: opts.sale.paymentMethod ?? PaymentMethod.CASH,
    subtotal: dec(opts.sale.subtotal),
    tax: dec(opts.sale.tax ?? 0),
    discount: dec(opts.sale.discount ?? 0),
    total: dec(opts.sale.total),
    amountPaid: dec(opts.sale.amountPaid),
    refundedTotal: dec(0),
    items,
  };
  const state = {
    balance: opts.customerBalance ?? 0,
    payments: [] as any[],
    moves: [] as any[],
    batchesBack: [] as any[],
    stockBack: 0,
    transactions: 0,
  };
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...params: any[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM "Sale"')) return [{ id: sale.id }];
      if (sql.includes('FROM "Customer"')) return [{ creditBalance: dec(state.balance) }];
      // The guarded bump: applied only while it stays within the line.
      const [delta, id] = params;
      const it = items.find((i) => i.id === id)!;
      if (it.returnedQty.plus(delta).greaterThan(it.quantity)) return [];
      it.returnedQty = it.returnedQty.plus(delta);
      return [{ id }];
    },
    sale: {
      findUniqueOrThrow: async () => sale,
      update: async ({ data }: any) => {
        if (data.amountPaid) sale.amountPaid = sale.amountPaid.plus(data.amountPaid.increment);
        sale.refundedTotal = sale.refundedTotal.plus(data.refundedTotal.increment);
        sale.status = data.status;
        return sale;
      },
    },
    saleItem: { findMany: async () => items },
    customer: {
      update: async ({ data }: any) => {
        state.balance = Math.round((state.balance - Number(data.creditBalance.decrement)) * 100) / 100;
      },
    },
    payment: {
      findFirst: async () =>
        opts.salePaymentMethod ? { method: opts.salePaymentMethod } : null,
    },
  };
  const prisma = stub<PrismaService>({
    sale: { findFirst: async () => sale },
    product: {
      findMany: async () =>
        (opts.batchTracked ?? []).map((id) => ({ id: `p-${id}`, trackSerials: false, trackBatches: true })),
    },
    // The preview reads the same things the return does, outside a transaction.
    customer: { findUnique: async () => ({ creditBalance: dec(state.balance) }) },
    payment: tx.payment,
    $transaction: async (fn: any) => {
      state.transactions++;
      return fn(tx);
    },
  });
  const service = new SalesService(
    prisma,
    stub<InventoryService>({
      applyMovementsBatch: async (_tx: any, moves: any[]) => {
        state.moves.push(...moves);
        state.stockBack += moves.reduce((n, m) => n + m.quantity, 0);
      },
      returnSerialsToStock: async () => undefined,
      restoreBatchOnReturn: async (_tx: any, input: any) => {
        state.batchesBack.push([input.productId, input.quantity]);
      },
    }),
    stub<MailService>({}),
    stub<ShiftsService>({ resolveShiftId: async () => opts.shiftId ?? null }),
    stub<PaymentsService>({
      record: async (input: any) => {
        state.payments.push(input);
        return input;
      },
    }),
  );
  const toItems = (lines: [string, number][]) =>
    lines.map(([saleItemId, quantity]) => ({ saleItemId, quantity }));
  const ret = (lines: [string, number][], extra: object = {}) =>
    service.returnItems(user, 'sale1', { items: toItems(lines), ...extra } as any) as Promise<any>;
  const quote = (lines: [string, number][]) =>
    service.returnQuote(user, 'sale1', toItems(lines)) as Promise<any>;
  return { sale, state, ret, quote };
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
  const { sale, ret } = returnHarness({
    sale: { subtotal: 1000, total: 1000, amountPaid: 1000 },
    items: [{ id: 'si1', quantity: 10, lineTotal: 1000 }],
  });

  const first = await ret([['si1', 2]]);
  assert.strictEqual(first.refund, 200, '2 of 10 units on a 1000 line');
  assert.strictEqual(
    sale.status,
    SaleStatus.PARTIALLY_RETURNED,
    '2 of 10 returned is a part return, not a full one',
  );

  // The remaining 8 must still be returnable, and close the sale out.
  const second = await ret([['si1', 8]]);
  assert.strictEqual(second.refund, 800, 'the rest of the line');
  assert.strictEqual(
    sale.status,
    SaleStatus.RETURNED,
    'every unit back on the shelf closes the sale out',
  );

  await assert.rejects(
    ret([['si1', 1]]),
    /already fully returned/,
    'a line cannot be returned past the quantity sold',
  );
}

/** A held cart never left the shelf, so nothing can come back against it. */
async function aHeldCartCannotBeReturned() {
  const { state, ret } = returnHarness({
    sale: { subtotal: 500, total: 500, amountPaid: 0, status: SaleStatus.HELD },
    items: [{ id: 'si1', quantity: 5, lineTotal: 500 }],
  });
  await assert.rejects(ret([['si1', 5]]), /held cart is not a sale/);
  assert.strictEqual(state.transactions, 0, 'refused before anything is written');
  assert.strictEqual(state.stockBack, 0, 'no stock appears');
  assert.strictEqual(state.payments.length, 0, 'no refund is recorded');
}

/**
 * The bill discount comes back off a return. A 100 bill with 10 off was paid
 * 90; returning all of it used to refund 100.
 */
async function aReturnGivesBackWhatWasPaidNotTheShelfPrice() {
  const { sale, state, ret } = returnHarness({
    // Two lines worth 60 (2 units) and 40, 10 off the bill: 90 paid by card.
    sale: { subtotal: 100, discount: 10, total: 90, amountPaid: 90, paymentMethod: PaymentMethod.CARD },
    items: [
      { id: 'a', quantity: 2, lineTotal: 60 },
      { id: 'b', quantity: 1, lineTotal: 40 },
    ],
    salePaymentMethod: PaymentMethod.CARD,
    shiftId: 'sh-now',
  });

  const first = await ret([['a', 1]]);
  assert.strictEqual(first.refund, 27, 'a 30 unit carries 10% of the discount: 27');

  const rest = await ret([['a', 1], ['b', 1]]);
  assert.strictEqual(rest.refund, 63, 'the last return refunds exactly what is left');
  assert.strictEqual(Number(sale.refundedTotal), 90, 'never more than the 90 paid');
  assert.strictEqual(sale.status, SaleStatus.RETURNED);

  assert.deepStrictEqual(
    state.payments.map((p) => [p.type, p.amount, p.method, p.shiftId]),
    [
      ['REFUND', 27, 'CARD', 'sh-now'],
      ['REFUND', 63, 'CARD', 'sh-now'],
    ],
    'refunded to the card it was paid on, from the till doing the return',
  );
}

/**
 * A return on a part-credit sale cancels what is still owed first, and only
 * what the customer still owes -- a khata paid off since then is not owed.
 */
async function aReturnCancelsOnlyCreditStillOwed() {
  // 400 sale, 150 paid in cash, 250 on the khata, still owed.
  const owing = returnHarness({
    sale: { subtotal: 400, total: 400, amountPaid: 150, paymentMethod: PaymentMethod.MIXED, customerId: 'c1' },
    items: [{ id: 'si1', quantity: 1, lineTotal: 400 }],
    customerBalance: 250,
    salePaymentMethod: PaymentMethod.CASH,
    shiftId: 'sh-now',
  });
  const r1 = await owing.ret([['si1', 1]]);
  assert.strictEqual(r1.refund, 400);
  assert.strictEqual(owing.state.balance, 0, 'the 250 owed is cancelled');
  assert.deepStrictEqual(
    owing.state.payments.map((p) => [p.amount, p.method]),
    [[150, 'CASH']],
    'only the 150 actually paid leaves the drawer',
  );

  // Same sale, but the customer has since paid the 250 off: nothing is owed,
  // so all 400 comes back to them. This used to cancel 250 of credit that no
  // longer existed -- balance -250, and 150 back for 400 of goods.
  const settled = returnHarness({
    sale: { subtotal: 400, total: 400, amountPaid: 150, paymentMethod: PaymentMethod.MIXED, customerId: 'c1' },
    items: [{ id: 'si1', quantity: 1, lineTotal: 400 }],
    customerBalance: 0,
    salePaymentMethod: PaymentMethod.CASH,
  });
  await settled.ret([['si1', 1]]);
  assert.strictEqual(settled.state.balance, 0, 'the balance never goes negative');
  assert.deepStrictEqual(
    settled.state.payments.map((p) => [p.amount, p.method]),
    [[400, 'CASH']],
    'the full value is handed back',
  );
}

/**
 * The preview a cashier sees before confirming is what the return then does,
 * and the cashier can choose the tender the money goes back on.
 */
async function aReturnPreviewMatchesTheReturn() {
  // 400 sale by card, 150 paid, 250 still on the khata.
  const h = returnHarness({
    sale: { subtotal: 400, total: 400, amountPaid: 150, paymentMethod: PaymentMethod.MIXED, customerId: 'c1' },
    items: [{ id: 'si1', quantity: 4, lineTotal: 400 }],
    customerBalance: 250,
    salePaymentMethod: PaymentMethod.CARD,
    shiftId: 'sh-now',
  });

  const preview = await h.quote([['si1', 4]]);
  assert.deepStrictEqual(
    preview,
    { refund: 400, creditCancelled: 250, cashBack: 150, closesSale: true, defaultMethod: 'CARD' },
    'the preview splits the refund into credit cancelled and money back',
  );
  assert.strictEqual(h.state.transactions, 0, 'a preview writes nothing');
  assert.strictEqual(h.state.balance, 250);

  // The customer wants the 150 in cash, not back on the card.
  const done = await h.ret([['si1', 4]], { refundMethod: 'CASH' });
  assert.deepStrictEqual(
    [done.refund, done.creditCancelled, done.cashBack, done.method],
    [preview.refund, preview.creditCancelled, preview.cashBack, 'CASH'],
    'the return does exactly what the preview said, on the chosen tender',
  );
  assert.deepStrictEqual(
    h.state.payments.map((p) => [p.type, p.amount, p.method, p.shiftId]),
    [['REFUND', 150, 'CASH', 'sh-now']],
    'recorded as cash, so the drawer knows it left',
  );

  await assert.rejects(h.quote([['si1', 1]]), /already fully returned/, 'nothing left to preview');
}

/**
 * Goods sent back on a paid purchase leave the supplier owing a refund. That
 * is recorded as owed (Purchase.refundDue) and reaches the ledger only when
 * the money arrives -- it used to be written as received on the spot.
 */
async function aSupplierRefundIsOwedUntilReceived() {
  const dec = (v: number) => new Prisma.Decimal(v);
  const item = {
    id: 'pi1',
    productId: 'p1',
    quantity: dec(10),
    returnedQty: dec(0),
    costPrice: dec(50),
    batchNumber: null,
    expiryDate: null,
  };
  // 500 of goods, paid in full.
  const purchase: any = {
    id: 'pu1',
    businessId: 'b1',
    storeId: 's1',
    supplierId: 'sup1',
    status: 'RECEIVED',
    subtotal: dec(500),
    total: dec(500),
    amountPaid: dec(500),
    refundDue: dec(0),
    note: null,
    items: [item],
  };
  const ledger: any[] = [];
  const tx: any = {
    $queryRaw: async (_sql: any, delta: string) => {
      item.returnedQty = item.returnedQty.plus(delta);
      return [{ id: item.id }];
    },
    purchase: {
      update: async ({ data }: any) => {
        Object.assign(purchase, {
          subtotal: dec(data.subtotal),
          total: dec(data.total),
          amountPaid: dec(data.amountPaid),
          refundDue: data.refundDue ? purchase.refundDue.plus(data.refundDue.increment) : purchase.refundDue,
        });
        return purchase;
      },
      updateMany: async ({ where, data }: any) => {
        if (purchase.refundDue.lessThan(where.refundDue.gte)) return { count: 0 };
        purchase.refundDue = purchase.refundDue.minus(data.refundDue.decrement);
        return { count: 1 };
      },
      findUniqueOrThrow: async () => purchase,
    },
  };
  const prisma = stub<PrismaService>({
    purchase: { findFirst: async () => purchase },
    product: { findMany: async () => [] },
    $transaction: async (fn: any) => fn(tx),
  });
  const service = new PurchasesService(
    prisma,
    stub<InventoryService>({ applyMovementsBatch: async () => undefined }),
    stub<PaymentsService>({ record: async (input: any) => ledger.push(input) }),
  );

  // Send 4 back: 200 of goods the supplier has been paid for.
  const ret: any = await service.returnItems('b1', 'u1', 'pu1', {
    items: [{ purchaseItemId: 'pi1', quantity: 4 }],
  } as any);
  assert.strictEqual(ret.refundDueFromSupplier, 200);
  assert.strictEqual(Number(purchase.refundDue), 200, 'the supplier owes 200 back');
  assert.strictEqual(Number(purchase.amountPaid), 300, 'paid now covers the smaller invoice');
  assert.strictEqual(ledger.length, 0, 'no money has moved yet, so no ledger row');

  await assert.rejects(
    service.recordRefundReceived('b1', 'pu1', 250),
    /more than the 200/,
    'cannot record more than is owed',
  );

  await service.recordRefundReceived('b1', 'pu1', 200, { method: 'MOBILE' as any, userId: 'u1' });
  assert.strictEqual(Number(purchase.refundDue), 0, 'nothing owed once received');
  assert.deepStrictEqual(
    ledger.map((p) => [p.type, p.amount, p.method, p.supplierId]),
    [['SUPPLIER_REFUND', 200, 'MOBILE', 'sup1']],
    'the ledger records the money when it arrives',
  );
}

/**
 * Goods that come back damaged are refunded like any return, but never reach
 * the shelf: booked in and written off, with the reason on both.
 */
async function damagedReturnsAreWrittenOff() {
  const h = returnHarness({
    sale: { subtotal: 300, total: 300, amountPaid: 300 },
    items: [
      { id: 'good', quantity: 1, lineTotal: 100 },
      { id: 'broken', quantity: 2, lineTotal: 200 },
    ],
    salePaymentMethod: PaymentMethod.CASH,
    batchTracked: ['good', 'broken'],
  });
  const res = await h.ret([['good', 1], ['broken', 2]], {
    reason: 'cracked in the box',
    items: [
      { saleItemId: 'good', quantity: 1 },
      { saleItemId: 'broken', quantity: 2, restock: false },
    ],
  });
  assert.strictEqual(res.refund, 300, 'damaged goods are refunded all the same');
  assert.deepStrictEqual(
    h.state.moves.map((m) => [m.productId, m.type, m.quantity, m.reason ?? null, m.note]),
    [
      ['p-good', 'RETURN_IN', 1, null, 'cracked in the box'],
      ['p-broken', 'RETURN_IN', 2, null, 'cracked in the box'],
      ['p-broken', 'ADJUSTMENT', -2, 'DAMAGE', 'Returned damaged: cracked in the box'],
    ],
    'the damaged line comes back and is written off, reason on both',
  );
  assert.strictEqual(h.state.stockBack, 1, 'only the good unit is back on the shelf');
  assert.deepStrictEqual(
    h.state.batchesBack,
    [['p-good', 1]],
    'the good unit rejoins a batch for expiry tracking; the written-off ones do not',
  );
  assert.strictEqual(h.state.payments[0].note, 'cracked in the box', 'the refund carries the reason');
}

/**
 * A cashier pinned to one branch can't return a sale rung up at another: the
 * route names the sale, not a store, so StoreScopeGuard has nothing to check.
 */
async function aPinnedCashierReturnsOnlyAtTheirStore() {
  const h = returnHarness({
    sale: { subtotal: 100, total: 100, amountPaid: 100 },
    items: [{ id: 'si1', quantity: 1, lineTotal: 100 }],
  });
  h.sale.storeId = 's2'; // the module's `user` is a cashier pinned to s1
  await assert.rejects(h.ret([['si1', 1]]), /store you are assigned to/);
  await assert.rejects(h.quote([['si1', 1]]), /store you are assigned to/, 'nor preview one');
  assert.strictEqual(h.state.transactions, 0, 'refused before anything is written');

  assert.doesNotThrow(
    () => assertOwnStore({ ...user, role: UserRole.OWNER }, 's2'),
    'owners and managers move between branches',
  );
  assert.doesNotThrow(
    () => assertOwnStore({ ...user, storeId: null }, 's2'),
    'staff with no store assigned are not pinned',
  );
}

/**
 * A product charges exactly the tax its form shows. Staff choose the tax per
 * product; changing that tax's rate moves every product on it, "No tax"
 * really clears it, and a tax still on an active product can't vanish from
 * under it.
 */
async function aProductChargesTheTaxItShows() {
  const products = [
    { id: 'p1', businessId: 'b1', taxId: 'vat', taxRate: 13, isActive: true },
    { id: 'p2', businessId: 'b1', taxId: 'vat', taxRate: 13, isActive: true },
    { id: 'p3', businessId: 'b1', taxId: null, taxRate: 0, isActive: true },
    { id: 'old', businessId: 'b1', taxId: 'retired', taxRate: 5, isActive: false },
  ] as any[];
  const taxes = [
    { id: 'vat', businessId: 'b1', rate: 13 },
    { id: 'retired', businessId: 'b1', rate: 5 },
  ] as any[];
  const matches = (p: any, where: any) =>
    Object.entries(where).every(([k, v]) => p[k] === v);
  const db: any = {
    tax: {
      findFirst: async ({ where }: any) => taxes.find((t) => t.id === where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(taxes.find((t) => t.id === where.id), data),
      delete: async ({ where }: any) => taxes.splice(taxes.findIndex((t) => t.id === where.id), 1)[0],
      updateMany: async () => ({ count: 0 }),
    },
    product: {
      updateMany: async ({ where, data }: any) => {
        const hit = products.filter((p) => matches(p, where));
        hit.forEach((p) => Object.assign(p, data));
        return { count: hit.length };
      },
      count: async ({ where }: any) => products.filter((p) => matches(p, where)).length,
    },
  };
  db.$transaction = async (fn: any) => fn(db);
  const taxesService = new TaxesService(stub<PrismaService>(db));

  await taxesService.update('b1', 'vat', { rate: 15 } as any);
  assert.deepStrictEqual(
    products.map((p) => p.taxRate),
    [15, 15, 0, 5],
    'VAT 13% -> 15% reaches every product on VAT, and only those',
  );

  await assert.rejects(
    taxesService.remove('b1', 'vat'),
    /2 products use this tax/,
    'a tax still on active products is not deleted from under them',
  );
  await taxesService.remove('b1', 'retired');
  assert.deepStrictEqual(
    [products[3].taxId, products[3].taxRate],
    [null, 0],
    'a retired product lets go of a deleted tax entirely',
  );

  // "No tax" on the product form clears the tax and the rate together.
  let saved: any = null;
  const productsService = new ProductsService(
    stub<PrismaService>({
      product: {
        findFirst: async () => ({ id: 'p1', businessId: 'b1' }),
        update: async ({ data }: any) => (saved = data),
      },
      category: { count: async () => 0 },
    }),
  );
  await productsService.update('b1', 'p1', { taxId: null } as any);
  assert.deepStrictEqual(
    [saved.taxId, saved.taxRate],
    [null, 0],
    'choosing No tax stops the product charging the old rate',
  );
}

/**
 * A part-paid sale records the tender the money came in on. The sale itself
 * says MIXED (part paid, part owed), and MIXED used to go on the payment row
 * too -- where the drawer counted it as cash.
 */
async function aPartPaymentKeepsItsTender() {
  const checkout = async (paymentMethod: PaymentMethod, amountPaid: number) => {
    let sale: any = null;
    const payments: any[] = [];
    const prisma = stub<PrismaService>({
      store: { findFirst: async () => ({ id: 's1' }) },
      customer: { findFirst: async () => ({ id: 'c1' }) },
      business: { findUnique: async () => ({ taxEnabled: true, taxInclusive: false }) },
      product: {
        findMany: async () => [
          { id: 'p1', name: 'Phone case', sellingPrice: 400, costPrice: 300, taxRate: 0, isTaxable: true, isActive: true, isRxRequired: false, trackBatches: false, trackSerials: false },
        ],
      },
      $transaction: async (fn: any) =>
        fn({
          sale: {
            findFirst: async () => null,
            create: async ({ data }: any) => (sale = { id: 'sale1', ...data }),
          },
          customer: { update: async () => ({}) },
        }),
    });
    const service = new SalesService(
      prisma,
      stub<InventoryService>({ applyMovementsBatch: async () => undefined }),
      stub<MailService>({}),
      stub<ShiftsService>({ resolveShiftId: async () => 'sh1' }),
      stub<PaymentsService>({ record: async (input: any) => payments.push(input) }),
    );
    await service.create(user, {
      items: [{ productId: 'p1', quantity: 1 }],
      customerId: 'c1',
      paymentMethod,
      amountPaid,
    } as any);
    return { sale, payment: payments[0] };
  };

  const card = await checkout(PaymentMethod.CARD, 150);
  assert.strictEqual(card.sale.paymentMethod, PaymentMethod.MIXED, 'the sale reads part paid');
  assert.strictEqual(card.payment.method, PaymentMethod.CARD, 'the money reads card');
  assert.strictEqual(card.payment.amount, 150);

  // A client that names no tender for the part paid gets the counter default.
  const credit = await checkout(PaymentMethod.CREDIT, 100);
  assert.strictEqual(credit.payment.method, PaymentMethod.CASH);
}

/**
 * A customer with a balance or any history can't be deleted. The database
 * never refuses (the links are ON DELETE SET NULL), so the service has to.
 */
async function aCustomerWithHistoryIsKept() {
  const build = (customer: { creditBalance: number }, sales: number, payments: number) => {
    let deleted = false;
    const prisma = stub<PrismaService>({
      customer: {
        findFirst: async () => ({ id: 'c1', businessId: 'b1', ...customer }),
        delete: async () => {
          deleted = true;
          return { id: 'c1' };
        },
      },
      sale: { count: async () => sales },
      payment: { count: async () => payments },
    });
    const service = new CustomersService(prisma, stub<PaymentsService>({}));
    return { service, wasDeleted: () => deleted };
  };

  const owes = build({ creditBalance: 250 }, 1, 0);
  await assert.rejects(owes.service.remove('b1', 'c1'), /still owes/);
  assert.ok(!owes.wasDeleted(), 'what they owe stays on the books');

  const bought = build({ creditBalance: 0 }, 3, 0);
  await assert.rejects(bought.service.remove('b1', 'c1'), /history/);

  const paid = build({ creditBalance: 0 }, 0, 1);
  await assert.rejects(paid.service.remove('b1', 'c1'), /history/);

  const unused = build({ creditBalance: 0 }, 0, 0);
  await unused.service.remove('b1', 'c1');
  assert.ok(unused.wasDeleted(), 'a customer never used can go');
}

/**
 * Credit ageing allocates what a customer owes across their credit sales. A
 * return that cancels credit raises the sale's amountPaid *and* its
 * refundedTotal by the amount cancelled; subtracting both made the sale look
 * short by the return, and that part of the balance fell into `unattributed`.
 */
async function creditAgeingCountsAReturnOnce() {
  const now = new Date('2026-09-25T12:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);
  const prisma = stub<PrismaService>({
    customer: {
      findMany: async () => [
        {
          id: 'c1',
          name: 'Ramesh',
          phone: null,
          // 1000 on credit, 300 of it returned (cancelling 300): owes 700.
          // Plus a newer 200 on credit: 900 in all.
          creditBalance: new Prisma.Decimal(900),
          sales: [
            { id: 's2', receiptNo: 'INV-2', createdAt: daysAgo(5), total: new Prisma.Decimal(200), refundedTotal: new Prisma.Decimal(0), amountPaid: new Prisma.Decimal(0) },
            { id: 's1', receiptNo: 'INV-1', createdAt: daysAgo(45), total: new Prisma.Decimal(1000), refundedTotal: new Prisma.Decimal(300), amountPaid: new Prisma.Decimal(300) },
          ],
        },
      ],
    },
  });
  const reports = new ReportsService(prisma, stub<InventoryService>({}));
  const ageing: any = await reports.creditAgeing('b1', { asOf: now });
  assert.strictEqual(ageing.total, 900, 'the parts add up to what is owed');
  assert.strictEqual(ageing.buckets.current, 200, 'the newer sale is current');
  assert.strictEqual(ageing.buckets.days30, 700, 'the returned sale still carries its 700');
  assert.strictEqual(ageing.unattributed, 0, 'nothing is left unexplained');
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
  const staleSale = {
    id: 'sale1',
    businessId: 'b1',
    storeId: 's1',
    customerId: null,
    status: SaleStatus.COMPLETED,
    subtotal: dec('100.00'),
    tax: dec('0.00'),
    total: dec('100.00'),
    refundedTotal: dec('0.00'),
    amountPaid: dec('100.00'),
    items: [stale],
  };
  const prisma = stub<PrismaService>({
    sale: { findFirst: async () => staleSale },
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
        $queryRaw: async (sql: TemplateStringsArray, ...params: any[]) => {
          // The sale lock. The read after it is the stale one here: that
          // lock is what normally prevents this, and the guard below is what
          // still holds if it ever doesn't.
          if (sql.join('?').includes('FROM "Sale"')) return [{ id: 'sale1' }];
          const delta = new Prisma.Decimal(params[0]);
          if (committed.returnedQty.plus(delta).greaterThan(committed.quantity)) {
            return [];
          }
          committed.returnedQty = committed.returnedQty.plus(delta);
          return [{ id: committed.id }];
        },
        sale: {
          findUniqueOrThrow: async () => staleSale,
          update: async ({ data }: any) => data,
        },
        customer: { update: async () => ({}) },
        payment: { findFirst: async () => null },
      }),
  });
  const inventory = stub<InventoryService>({
    applyMovementsBatch: async () => undefined,
    returnSerialsToStock: async () => undefined,
  });
  const service = new SalesService(
    prisma,
    inventory,
    stub<MailService>({}),
    stub<ShiftsService>({ resolveShiftId: async () => null }),
    stub<PaymentsService>({ record: async () => undefined }),
  );

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
      stub<SettingsService>({}),
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
    counts: { sales: number; shifts: number; movements: number; cash?: number },
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
        cashMovement: { count: async () => counts.cash ?? 0 },
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
    // An owner who only ever paid out of a cashier's till has no shift of their own.
    [{ sales: 0, shifts: 0, movements: 0, cash: 2 }, /2 cash pay in\/outs/],
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

/** "View as owner" can read and cannot write -- enforced by the API itself. */
async function viewAsOwnerIsReadOnly() {
  const guard = new ImpersonationReadOnlyGuard();
  const ctx = (method: string, user?: Partial<AuthUser>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ method, user }) }) }) as never;
  const owner: Partial<AuthUser> = { userId: 'u1', businessId: 'b1', role: UserRole.OWNER };
  const viewing = { ...owner, impersonatedBy: { adminId: 'a1', email: 'a@x.com', expiresAt: '' } };

  for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.throws(() => guard.canActivate(ctx(m, viewing)), ForbiddenException, `${m} is refused while viewing`);
    assert.ok(guard.canActivate(ctx(m, owner)), `${m} still works for the owner themselves`);
  }
  for (const m of ['GET', 'HEAD', 'OPTIONS']) {
    assert.ok(guard.canActivate(ctx(m, viewing)), `${m} is allowed while viewing`);
  }
  assert.ok(guard.canActivate(ctx('POST')), 'public routes (no user) are untouched');

  // The full export is a GET, so the guard passes it; the route refuses it
  // itself. Nothing may be written to the response first.
  let wrote = false;
  const res = stub<never>({ setHeader: () => (wrote = true), write: () => (wrote = true), end: () => (wrote = true) });
  const controller = new BusinessController(
    stub<BusinessService>({
      exportNdjson: async function* () {
        yield '';
      },
    }),
  );
  await assert.rejects(
    controller.exportData(viewing as AuthUser, res),
    ForbiddenException,
    'the owner export is refused while viewing',
  );
  assert.ok(!wrote, 'no headers or rows went out');
}

/**
 * Admin two-factor. Checked against RFC 6238's own test vector, because an
 * off-by-one here passes every round-trip test and fails every real phone.
 */
function adminTotpMatchesTheRfc() {
  // RFC 6238 appendix B, SHA-1: secret "12345678901234567890", T=59s ->
  // 94287082 (8 digits), so 287082 for 6. T=1111111109 -> 07081804 -> 081804.
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  assert.strictEqual(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.strictEqual(totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.strictEqual(totpCode(secret, Math.floor(1111111109 / 30)), '081804', 'leading zeros kept');
  assert.deepStrictEqual(base32Decode(secret), Buffer.from('12345678901234567890', 'ascii'));

  // One step of drift either way is accepted, and reports which step matched.
  const now = 1111111109 * 1000;
  const step = Math.floor(1111111109 / 30);
  assert.strictEqual(verifyTotp(secret, totpCode(secret, step), now), step);
  assert.strictEqual(verifyTotp(secret, totpCode(secret, step - 1), now), step - 1);
  assert.strictEqual(verifyTotp(secret, totpCode(secret, step + 1), now), step + 1);
  assert.strictEqual(verifyTotp(secret, totpCode(secret, step - 2), now), null, 'a minute old is too old');
  assert.strictEqual(verifyTotp(secret, ' 081 804 ', now), step, 'spaces people type are ignored');
  assert.strictEqual(verifyTotp(secret, '12345', now), null);
  assert.strictEqual(verifyTotp(secret, 'abcdef', now), null);

  // Secrets at rest: round-trip, and tampering is detected rather than
  // decrypting to garbage.
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'j'.repeat(48);
  try {
    const stored = encryptTotpSecret(secret);
    assert.notStrictEqual(stored, secret);
    assert.ok(!stored.includes(secret), 'the secret is not stored in the clear');
    assert.strictEqual(decryptTotpSecret(stored), secret);
    const parts = stored.split(':');
    const flipped = Buffer.from(parts[3], 'base64');
    flipped[0] ^= 1;
    parts[3] = flipped.toString('base64');
    assert.throws(() => decryptTotpSecret(parts.join(':')), 'a tampered secret does not decrypt');
    process.env.JWT_SECRET = 'k'.repeat(48);
    assert.throws(() => decryptTotpSecret(stored), 'a different key does not decrypt it');
  } finally {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  }

  const url = otpauthUrl('admin@platform.com', secret);
  assert.ok(url.startsWith('otpauth://totp/Inventory%20Admin%3Aadmin%40platform.com?'));
  assert.ok(url.includes(`secret=${secret}`) && url.includes('issuer=Inventory+Admin'));
}

/**
 * Wrong two-factor codes are counted per account. The login route's throttle
 * is per IP, so without this someone holding the password could spread
 * guesses across addresses. Also: turning two-factor on ends every other
 * session, as a password change does.
 */
async function adminTotpLocksAfterRepeatedWrongCodes() {
  const saved = { jwt: process.env.JWT_SECRET, totp: process.env.TOTP_ENCRYPTION_KEY };
  process.env.JWT_SECRET = 'j'.repeat(48);
  delete process.env.TOTP_ENCRYPTION_KEY;
  try {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const row: any = {
      id: 'a1',
      email: 'admin@platform.com',
      name: 'Admin',
      role: PlatformRole.ADMIN,
      isActive: true,
      passwordHash: '',
      totpSecret: encryptTotpSecret(secret),
      totpEnabledAt: new Date(),
      totpLastStep: null,
      totpFailedAttempts: 0,
      totpLockedUntil: null,
      passwordChangedAt: null,
    };
    const apply = (data: any) => {
      for (const [k, v] of Object.entries(data)) {
        row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + (v as any).increment : v;
      }
    };
    const service = new PlatformAuthService(
      stub<PrismaService>({
        platformAdmin: {
          findUnique: async () => ({ ...row }),
          update: async ({ data }: any) => {
            apply(data);
            return { ...row };
          },
          updateMany: async ({ data }: any) => {
            if (row.totpLastStep !== null) return { count: 0 };
            apply(data);
            return { count: 1 };
          },
        },
      }),
      new JwtService({ secret: 'p'.repeat(48) }),
      stub<PlatformAuditService>({ record: async () => undefined }),
    );
    // acceptCode is private; the lock logic is what's under test, not login's
    // password check (argon2 would need a real hash here).
    const accept = (code: string) => (service as any).acceptCode(row, code) as Promise<string>;
    const good = totpCode(secret, Math.floor(Date.now() / 30_000));

    for (let i = 1; i < 5; i++) assert.strictEqual(await accept('000000'), 'wrong', `wrong code ${i}`);
    assert.strictEqual(await accept('000000'), 'locked', 'the fifth wrong code locks the account');
    assert.ok(row.totpLockedUntil > new Date(), 'the lock is in the future');
    assert.strictEqual(await accept(good), 'locked', 'even the right code is refused while locked');
    assert.strictEqual(row.totpLastStep, null, 'and it is not spent');

    row.totpLockedUntil = new Date(Date.now() - 1000);
    row.totpFailedAttempts = 3;
    assert.strictEqual(await accept(good), 'ok', 'the right code works once the lock runs out');
    assert.strictEqual(row.totpFailedAttempts, 0, 'a right code clears the count');
    assert.strictEqual(row.totpLockedUntil, null);

    // Enabling: other sessions end, this one gets a fresh token.
    row.totpEnabledAt = null;
    row.totpLastStep = null;
    const next = totpCode(secret, Math.floor(Date.now() / 30_000));
    const res = await service.enableTwoFactor({ adminId: 'a1', email: row.email, ip: null }, next);
    assert.ok(res.accessToken, 'enabling returns a token for this session');
    assert.ok(row.passwordChangedAt instanceof Date, 'and retires the tokens issued before it');
  } finally {
    if (saved.jwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved.jwt;
    if (saved.totp !== undefined) process.env.TOTP_ENCRYPTION_KEY = saved.totp;
  }
}

/**
 * The grace period and what the shop app is told. A lock-out a day early
 * stops a paying shop's till; one that never comes gives the app away.
 */
function subscriptionGraceAndSummary() {
  const saved = { grace: process.env.SUBSCRIPTION_GRACE_DAYS, email: process.env.SUPPORT_EMAIL };
  process.env.SUBSCRIPTION_GRACE_DAYS = '3';
  process.env.SUPPORT_EMAIL = 'help@example.com';
  try {
    const now = new Date('2026-09-24T09:00:00Z');
    const inDays = (d: number) => new Date(now.getTime() + d * DAY_MS);
    const biz = (subscribedTo: Date | null, isSubscribed = true) => ({ isSubscribed, subscribedTo });

    // Access: ends at end date + grace, not at the end date.
    assert.ok(isSubscriptionActive(biz(inDays(-1)), now), 'one day past the end date is inside a 3-day grace');
    assert.ok(isSubscriptionActive(biz(new Date(inDays(-3).getTime() + 1)), now), 'the last millisecond of grace still works');
    assert.ok(!isSubscriptionActive(biz(inDays(-3)), now), 'grace over: locked out');
    assert.ok(!isSubscriptionActive(biz(inDays(30), false), now), 'switched off is locked out whatever the date');
    assert.ok(isSubscriptionActive(biz(null), now), 'no end date never expires');
    process.env.SUBSCRIPTION_GRACE_DAYS = '0';
    assert.ok(!isSubscriptionActive(biz(new Date(now.getTime() - 1)), now), 'grace 0 locks out on the end date');
    process.env.SUBSCRIPTION_GRACE_DAYS = 'nonsense';
    assert.ok(isSubscriptionActive(biz(inDays(-2)), now), 'an unparseable grace falls back to the default, not to 0');
    process.env.SUBSCRIPTION_GRACE_DAYS = '3';

    // The banner the owner sees.
    assert.strictEqual(subscriptionSummary(biz(inDays(5)), 0, now).status, 'trial');
    assert.strictEqual(subscriptionSummary(biz(inDays(5)), 0, now).daysLeft, 5);
    assert.strictEqual(subscriptionSummary(biz(inDays(5)), 2, now).status, 'ending');
    assert.strictEqual(subscriptionSummary(biz(inDays(40)), 2, now).status, 'active');
    const grace = subscriptionSummary(biz(inDays(-1)), 2, now);
    assert.strictEqual(grace.status, 'grace');
    assert.strictEqual(grace.daysLeft, 2, 'days until the app actually stops, not since it ended');
    assert.deepStrictEqual((grace as { contact?: object }).contact, { email: 'help@example.com' });
    assert.strictEqual(subscriptionSummary(biz(null), 0, now).status, 'active', 'no end date: nothing to warn about');

    // The lock-out response carries what the expired screen needs.
    const body = new SubscriptionInactiveException(biz(inDays(-4))).getResponse() as Record<string, unknown>;
    assert.strictEqual(body.code, 'SUBSCRIPTION_INACTIVE');
    assert.strictEqual(body.reason, 'expired');
    assert.strictEqual(body.endedAt, inDays(-4).toISOString());
    assert.strictEqual(new SubscriptionInactiveException(biz(null, false)).getStatus(), 401, 'still a 401 for older app builds');
    assert.strictEqual(
      (new SubscriptionInactiveException(biz(inDays(9), false)).getResponse() as Record<string, unknown>).reason,
      'inactive',
      'switched off reads as inactive, not as expired with a future date',
    );
  } finally {
    if (saved.grace === undefined) delete process.env.SUBSCRIPTION_GRACE_DAYS;
    else process.env.SUBSCRIPTION_GRACE_DAYS = saved.grace;
    if (saved.email === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = saved.email;
  }
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

  const trial = trialEndsAt(14, now);
  assert.strictEqual(trial.getTime() - now.getTime(), 14 * DAY_MS, 'a 14-day trial ends 14 days on');
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

/**
 * Read and dismissed belong to the person, not the shop: a cashier opening
 * the bell must not clear the owner's badge or hide a notice from them.
 */
async function aNotificationIsReadPerPerson() {
  const writes: { userId: string; notificationId: string }[] = [];
  const updates: any[] = [];
  const db: any = {
    notification: {
      findMany: async (args: any) => {
        // markAllRead asks only for what *this* user hasn't read or dismissed.
        assert.strictEqual(args.where.receipts.none.userId, 'u2', 'the unread query is scoped to the caller');
        return [{ id: 'n1' }, { id: 'n2' }];
      },
      findFirst: async (args: any) => (args.where.businessId === 'b1' ? { id: args.where.id } : null),
    },
    notificationReceipt: {
      createMany: (args: any) => {
        writes.push(...args.data);
        return args;
      },
      updateMany: (args: any) => {
        updates.push(args.where);
        return args;
      },
    },
  };
  db.$transaction = async (ops: unknown[]) => ops;
  const service = new NotificationsService(stub<PrismaService>(db), stub<InventoryService>({}));

  await service.markAllRead('b1', 'u2');
  assert.deepStrictEqual(
    writes.map((w) => [w.notificationId, w.userId]),
    [['n1', 'u2'], ['n2', 'u2']],
    "receipts are written for the caller only -- nobody else's badge moves",
  );
  assert.strictEqual(updates[0].readAt, null, 'an existing read time is kept, not moved');

  writes.length = 0;
  await service.dismiss('other-shop', 'u2', 'n9');
  assert.strictEqual(writes.length, 0, "another shop's notification can't be touched");
}

/**
 * Getting paid: receipt numbers print the same everywhere, the renewals list
 * tells trials from paying shops and flags the overdue ones, and a bulk
 * reminder sends once per shop and skips what it can't remind about.
 */
async function renewalsAndReceipts() {
  assert.strictEqual(formatReceiptNo(42), 'SUB-000042');
  assert.strictEqual(formatReceiptNo(1234567), 'SUB-1234567', 'no truncation past six digits');

  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const reminded: string[] = [];
  const audits: any[] = [];
  const db: any = {
    business: {
      findMany: async (args: any) => {
        if (args.select?.subscriptionPayments) {
          return [
            { id: 'late', name: 'Late', currency: 'NPR', subscribedTo: new Date(now - 2 * day),
              _count: { subscriptionPayments: 1 },
              subscriptionPayments: [{ amount: new Prisma.Decimal(2000), currency: 'NPR', periodFrom: new Date(), periodTo: new Date(), createdAt: new Date() }],
              users: [] },
            { id: 'trial', name: 'Trial', currency: 'NPR', subscribedTo: new Date(now + 5 * day),
              _count: { subscriptionPayments: 0 }, subscriptionPayments: [], users: [] },
          ];
        }
        // remind(): only businesses that exist and have an end date come back.
        return args.where.id.in
          .filter((id: string) => id !== 'ghost')
          .map((id: string) => ({ id, name: id, subscribedTo: new Date(now + 3 * day) }));
      },
    },
  };
  const service = new PlatformBillingService(
    stub<PrismaService>(db),
    stub<MailService>({}),
    stub<SettingsService>({}),
    stub<PlatformAuditService>({ record: async (_a: unknown, action: string, d: unknown) => audits.push({ action, d }) }),
    stub<SubscriptionRemindersService>({
      remind: async (b: { id: string }) => {
        reminded.push(b.id);
        return { alreadySent: false, emailed: 1, failed: 0 };
      },
    }),
  );

  const rows = await service.renewals(30);
  const late = rows.find((r) => r.id === 'late')!;
  const trial = rows.find((r) => r.id === 'trial')!;
  assert.strictEqual(late.overdue, true, 'past the end date is overdue');
  assert.strictEqual(late.kind, 'paid');
  assert.strictEqual(late.lastPayment?.amount, 2000, 'what they last paid, as a number');
  assert.ok(late.accessEndsAt >= late.endsAt, 'lock-out comes at or after the end date (grace)');
  assert.strictEqual(trial.kind, 'trial', 'never paid = trial');
  assert.strictEqual(trial.overdue, false);
  assert.strictEqual(trial.lastPayment, null);

  const admin = { adminId: 'a1', email: 'a1@x.com' };
  const res = await service.remind(admin, ['s1', 's1', 's2', 'ghost']);
  assert.deepStrictEqual(reminded, ['s1', 's2'], 'each shop reminded once');
  assert.deepStrictEqual(res, { reminded: 2, skipped: 1, emailed: 2, failed: 0 }, 'the unknown one is skipped, not fatal');
  assert.strictEqual(audits.length, 2, 'one admin-log entry per shop, so each business page shows it');
}

/**
 * Onboarding: each setup step is read from the right count, and "stuck"
 * means old enough to have sold by now but hasn't -- a shop that signed up
 * today isn't stuck yet.
 */
async function onboardingFlagsTheStuckShops() {
  const day = 24 * 60 * 60 * 1000;
  const shop = (id: string, ageDays: number, c: Record<string, number>) => ({
    id, name: id, type: 'GROCERY', createdAt: new Date(Date.now() - ageDays * day),
    isSubscribed: true, subscribedTo: new Date(Date.now() + 5 * day),
    _count: { products: 0, users: 1, sales: 0, shifts: 0, subscriptionPayments: 0, ...c },
    users: [{ name: 'Owner', email: `${id}@x.com` }], stores: [],
  });
  const service = new PlatformService(
    stub<PrismaService>({
      business: {
        findMany: async () => [
          shop('quiet', 5, { products: 12 }),
          shop('new', 0, {}),
          shop('busy', 10, { products: 40, users: 3, sales: 90, shifts: 4, subscriptionPayments: 2 }),
        ],
      },
      sale: { groupBy: async () => [{ businessId: 'busy', _min: { createdAt: new Date('2026-09-01') } }] },
      $queryRaw: async () => [],
    }),
    stub<MailService>({}), stub<PlatformAuditService>({}), stub<SubscriptionRemindersService>({}),
    stub<PlatformBillingService>({}), stub<BusinessService>({}), stub<AuthService>({}), stub<SettingsService>({}),
  );
  const rows = await service.onboarding({ scope: 'all' });
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.deepStrictEqual(by.get('quiet')!.steps, { products: true, firstSale: false, staff: false, shiftClosed: false, paid: false });
  assert.strictEqual(by.get('quiet')!.stuck, true, '5 days, products in, still no sale: stuck');
  assert.strictEqual(by.get('new')!.stuck, false, 'signed up today: not stuck yet');
  assert.strictEqual(by.get('busy')!.done, 5, 'every step done');
  assert.strictEqual(by.get('busy')!.stuck, false);
  assert.strictEqual(by.get('busy')!.trialEndsAt, null, 'a paying shop has no trial end');
  assert.ok(by.get('busy')!.firstSaleAt, 'first sale date comes through');
}

/**
 * Announcements: every audience keeps suspended shops out, a time a minute
 * or less away (or in the past) means "now", a scheduled one reaches nobody
 * until the job sends it, and the job never sends one twice.
 */
async function announcementsScheduleAndTarget() {
  const now = new Date();
  for (const audience of ['all', 'trial', 'active', 'expiring', 'expired', 'selected']) {
    const w = JSON.stringify(audienceWhere({ audience, businessIds: ['b1'] }, now));
    assert.ok(w.includes('"isSuspended":false'), `${audience}: suspended shops are never reached`);
  }
  assert.ok(JSON.stringify(audienceWhere({ audience: 'selected', businessIds: ['b1'] }, now)).includes('"in":["b1"]'));
  assert.throws(() => audienceWhere({ audience: 'everyone', businessIds: [] }, now), /Unknown audience/);

  const made: any[] = [];
  const notes: any[] = [];
  let claims = 0;
  const db: any = {
    announcement: {
      create: async ({ data }: any) => {
        const a = { id: `a${made.length + 1}`, ...data, createdAt: new Date(), cancelledAt: null };
        made.push(a);
        return a;
      },
      update: async () => ({}),
      findMany: async () => made.filter((a) => a.scheduledFor && !a.sentAt),
      updateMany: async ({ where }: any) => {
        const a = made.find((x) => x.id === where.id);
        if (!a || a.sentAt) return { count: 0 };
        a.sentAt = new Date();
        claims++;
        return { count: 1 };
      },
    },
    business: {
      findMany: async () => [{ id: 'b1', name: 'Shop' }],
      count: async () => 1,
    },
    notification: { createMany: async ({ data }: any) => notes.push(...data) },
  };
  const service = new PlatformAnnouncementsService(
    stub<PrismaService>(db),
    stub<MailService>({}),
    stub<PlatformAuditService>({ record: async () => {} }),
  );
  const admin = { adminId: 'x', email: 'x@y.com' };

  const past = await service.send(admin, { title: 'Hi there', body: 'b', scheduledFor: new Date(Date.now() - 5000).toISOString() });
  assert.strictEqual(past.scheduled, false, 'a time already gone means now');
  assert.strictEqual(notes.length, 1, 'and it went out');
  assert.strictEqual(notes[0].announcementId, 'a1', 'linked for its "seen by" count');

  const later = await service.send(admin, { title: 'Later on', body: 'b', audience: 'trial', scheduledFor: new Date(Date.now() + 3600_000).toISOString() });
  assert.strictEqual(later.scheduled, true);
  assert.strictEqual(notes.length, 1, 'scheduled: nobody reached yet');

  made[1].scheduledFor = new Date(Date.now() - 1000); // it's due now
  await service.runDue();
  await service.runDue(); // a second run (or a second server) finds nothing left to send
  assert.strictEqual(notes.length, 2, 'the job sent it exactly once');
  assert.strictEqual(claims, 1, 'claimed once');

  await assert.rejects(
    service.send(admin, { title: 'Too far', body: 'b', scheduledFor: new Date(Date.now() + 91 * 86400_000).toISOString() }),
    /within 90 days/,
  );
}

/**
 * Support assignment: a deactivated admin can't be handed a ticket, and the
 * first admin to reply to an unassigned ticket takes it.
 */
async function supportTicketsGetAnOwner() {
  let assignedTo: string | null | undefined;
  let ticket: any = {
    id: 't1', businessId: 'b1', subject: 'Help', userEmail: 'o@x.com', userName: 'O',
    status: 'OPEN', assignedAdmin: null, messages: [],
  };
  const db: any = {
    supportTicket: {
      findUnique: async () => ticket,
      update: async ({ data }: any) => {
        if ('assignedAdminId' in data) {
          assignedTo = data.assignedAdminId;
          ticket = { ...ticket, assignedAdmin: data.assignedAdminId ? { id: data.assignedAdminId, name: 'A' } : null };
        }
        return ticket;
      },
    },
    supportMessage: { create: async () => ({}) },
    notification: { create: async () => ({}) },
    platformAdmin: {
      findUnique: async () => ({ name: 'Anil' }),
      findFirst: async (args: any) => (args.where.id === 'active' ? { id: 'active', email: 'a@x.com' } : null),
    },
  };
  db.$transaction = async (ops: unknown[]) => Promise.all(ops);
  const service = new SupportService(
    stub<PrismaService>(db),
    stub<MailService>({ sendSupportReply: async () => {} }),
    stub<PlatformAuditService>({ record: async () => {} }),
  );
  const me = { adminId: 'me', email: 'me@x.com' };

  await assert.rejects(service.assign(me, 't1', 'retired'), /does not exist or is deactivated/);
  await service.replyFromAdmin(me, 't1', 'On it');
  assert.strictEqual(assignedTo, 'me', 'answering an unassigned ticket takes it');

  assignedTo = undefined;
  await service.replyFromAdmin({ adminId: 'other', email: 'o@x.com' }, 't1', 'Also me');
  assert.strictEqual(assignedTo, undefined, "a second admin replying doesn't steal it");

  await service.assign(me, 't1', null);
  assert.strictEqual(assignedTo, null, 'unassign');
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

/**
 * An owner joins the cashier's drawer rather than opening a second one for
 * the same physical till -- but never guesses which when more than one is
 * running, and never lets a cashier onto someone else's.
 */
async function anOwnerJoinsTheTillAlreadyOpen() {
  const owner: AuthUser = { ...user, userId: 'owner1', role: 'OWNER' as AuthUser['role'] };
  const cashier: AuthUser = { ...user, userId: 'u2', role: 'CASHIER' as AuthUser['role'] };

  // `open` is every shift currently open at store s1.
  const build = (open: { id: string; userId: string }[]) =>
    new ShiftsService(
      stub<PrismaService>({
        shift: {
          // resolveShiftId asks for the caller's own shift first.
          findFirst: async (args: any) => {
            if (args.where.id) {
              return open.find((sh) => sh.id === args.where.id) ?? null;
            }
            return open.find((sh) => sh.userId === args.where.userId) ?? null;
          },
          findMany: async () => open,
        },
      }),
      stub<PaymentsService>({ cashCollectedOnShift: async () => 0 }),
    );

  const ramesh = { id: 'sh-ramesh', userId: 'u2' };
  const sita = { id: 'sh-sita', userId: 'u3' };

  assert.strictEqual(
    await build([ramesh]).resolveShiftId(owner, 's1'),
    'sh-ramesh',
    'one till open at the store: the owner joins it',
  );

  assert.strictEqual(
    await build([ramesh, sita]).resolveShiftId(owner, 's1'),
    null,
    'two tills open: the owner is asked rather than guessed for',
  );

  assert.strictEqual(
    await build([ramesh, sita]).resolveShiftId(owner, 's1', 'sh-sita'),
    'sh-sita',
    'once asked, the answer is honoured',
  );

  assert.strictEqual(
    await build([ramesh]).resolveShiftId(cashier, 's1'),
    'sh-ramesh',
    "a cashier still gets their own till (it is Ramesh's own id here)",
  );

  const other = { id: 'sh-other', userId: 'u9' };
  assert.strictEqual(
    await build([other]).resolveShiftId(cashier, 's1'),
    null,
    'a cashier is never put on a till someone else opened',
  );

  await assert.rejects(
    build([other]).resolveShiftId(cashier, 's1', 'sh-other'),
    /owner or manager/,
    'and cannot get there by naming it either',
  );

  await assert.rejects(
    build([ramesh]).resolveShiftId(owner, 's1', 'sh-closed'),
    /No open shift/,
    'a remembered till that has since closed is refused, not silently swapped',
  );

  assert.strictEqual(
    await build([]).resolveShiftId(owner, 's1'),
    null,
    'nothing open at the store means no drawer, so the sale carries none',
  );
}

/**
 * Every balance change writes a ledger row, in the same transaction.
 *
 * The invariant the Payment table exists for: if a payment can move a balance
 * without leaving a record, or leave a record without moving the balance, the
 * two drift and nothing afterwards can say which is right.
 */
async function everyPaymentLeavesATrail() {
  const recorded: any[] = [];
  let balance = 500;

  const makeService = () => {
    const prisma = stub<PrismaService>({
      customer: {
        findFirst: async () => ({ id: 'c1', businessId: 'b1' }),
        findUniqueOrThrow: async () => ({ id: 'c1', creditBalance: balance }),
        updateMany: async (args: any) => {
          // Mirrors the guarded decrement: only moves when the balance covers it.
          const need = Number(args.data.creditBalance.decrement);
          if (balance < need) return { count: 0 };
          balance -= need;
          return { count: 1 };
        },
      },
      // The real service runs both writes inside one interactive transaction;
      // the stub just runs the callback, and the assertions below check that
      // a failure part-way leaves nothing behind.
      $transaction: async (fn: any) => fn(prisma),
    });
    const payments = stub<PaymentsService>({
      record: async (input: any) => {
        recorded.push(input);
        return input;
      },
    });
    return new CustomersService(prisma, payments);
  };

  const service = makeService();

  await service.payCredit('b1', 'c1', 200, {
    method: 'CARD' as any,
    userId: 'u1',
    shiftId: 'sh1',
  });
  assert.strictEqual(balance, 300, 'balance moved by the amount paid');
  assert.strictEqual(recorded.length, 1, 'exactly one ledger row per payment');
  assert.strictEqual(recorded[0].type, 'CUSTOMER_CREDIT', 'typed as a credit payment');
  assert.strictEqual(recorded[0].amount, 200, 'amount recorded positive');
  assert.strictEqual(recorded[0].method, 'CARD', 'method carried through, not defaulted');
  assert.strictEqual(recorded[0].shiftId, 'sh1', 'attributed to the till that took it');

  // Overpaying must move nothing and record nothing.
  await assert.rejects(
    service.payCredit('b1', 'c1', 10_000, {}),
    /exceeds/,
    'paying more than is owed is refused',
  );
  assert.strictEqual(balance, 300, 'a refused payment leaves the balance alone');
  assert.strictEqual(recorded.length, 1, 'and writes no ledger row');

  // Cash is the counter's default, since that is what a till takes.
  await service.payCredit('b1', 'c1', 50, {});
  assert.strictEqual(recorded[1].method, 'CASH', 'defaults to cash when unstated');
}

/**
 * A customer statement reconstructs the stored balance from events.
 *
 * The case that broke it: a return against a credit sale cancels credit, which
 * raises the sale's `amountPaid` *and* its `refundedTotal` by the same amount.
 * Subtracting both counted the return twice and invented an opening balance on
 * an account the ledger fully explains.
 */
async function aStatementCountsAReturnOnce() {
  // Rs 1000 on credit, 300 of it returned (cancelling 300 of credit), then
  // 200 paid down in cash. Owed: 1000 - 300 - 200 = 500.
  const prisma = stub<PrismaService>({
    customer: {
      findFirstOrThrow: async () => ({
        id: 'c1',
        name: 'Sita',
        phone: null,
        creditBalance: new Prisma.Decimal(500),
      }),
    },
    payment: {
      findMany: async () => [
        {
          id: 'p1',
          type: 'CUSTOMER_CREDIT',
          amount: new Prisma.Decimal(200),
          method: 'CASH',
          note: null,
          createdAt: new Date(),
          saleId: null,
          purchaseId: null,
          user: null,
          store: null,
        },
      ],
    },
    sale: {
      findMany: async () => [
        {
          id: 's1',
          receiptNo: 'R-1',
          createdAt: new Date(),
          total: new Prisma.Decimal(1000),
          amountPaid: new Prisma.Decimal(300),
          refundedTotal: new Prisma.Decimal(300),
        },
      ],
    },
  });
  const st: any = await new PaymentsService(prisma).customerStatement('b1', 'c1');
  assert.strictEqual(st.totals.charged, 700, 'the return is netted out once');
  assert.strictEqual(st.totals.paid, 200, 'credit payments come off');
  assert.strictEqual(st.openingBalance, 0, 'nothing unexplained');
  assert.strictEqual(st.reconciles, true, 'rebuilt purely from events');
  assert.strictEqual(st.totals.closing, st.totals.stored, 'closing is the stored balance');
}

/** The last active store cannot be closed through the API. */
async function theLastActiveStoreStaysOpen() {
  let others = 0;
  let closed = false;
  const prisma = stub<PrismaService>({
    store: {
      findFirst: async () => ({ id: 'st1', businessId: 'b1', isActive: true }),
      count: async () => others,
      update: async () => {
        closed = true;
        return {};
      },
    },
  });
  const service = new StoresService(prisma);

  await assert.rejects(service.remove('b1', 'st1'), /only active store/, 'refused when it is the last');
  await assert.rejects(
    service.update('b1', 'st1', { isActive: false }),
    /only active store/,
    'and through update too',
  );
  assert.strictEqual(closed, false, 'nothing written');

  others = 1;
  await service.remove('b1', 'st1');
  assert.strictEqual(closed, true, 'allowed while another store is open');
}

/** Moving a category under its own subcategory would save a loop. */
async function aCategoryCannotBecomeItsOwnAncestor() {
  let loop = true;
  const prisma = stub<PrismaService>({
    category: {
      findFirst: async (args: any) => ({ id: args.where.id, businessId: 'b1' }),
      update: async () => ({}),
    },
    $queryRaw: async () => (loop ? [{ id: 'a' }] : []),
  });
  const service = new CategoriesService(prisma);

  await assert.rejects(
    service.update('b1', 'a', { parentId: 'b' }),
    /own subcategories/,
    'A under B is refused when B is already under A',
  );
  loop = false;
  await service.update('b1', 'a', { parentId: 'b' });
}

/**
 * Admin-panel tokens are signed with their own key. With one shared
 * JWT_SECRET, only the `scope` claim check stood between a shop token and the
 * platform strategy; a different key means one cannot even verify as the other.
 */
function platformTokensUseTheirOwnKey() {
  const shopSecret = 'x'.repeat(48);
  const env = (vars: Record<string, string>) => (k: string) => vars[k];

  const derived = platformJwtSecret(env({ JWT_SECRET: shopSecret }));
  assert.notStrictEqual(derived, shopSecret, 'the derived key is not JWT_SECRET');
  assert.strictEqual(
    derived,
    platformJwtSecret(env({ JWT_SECRET: shopSecret })),
    'the derived key is stable across restarts, or every restart signs admins out',
  );
  assert.strictEqual(
    platformJwtSecret(env({ JWT_SECRET: shopSecret, PLATFORM_JWT_SECRET: 'p'.repeat(40) })),
    'p'.repeat(40),
    'an explicit PLATFORM_JWT_SECRET wins',
  );

  const shop = new JwtService({ secret: shopSecret });
  const platform = new JwtService({ secret: derived });
  assert.throws(
    () => platform.verify(shop.sign({ sub: 'u1', scope: 'platform' })),
    'a shop-signed token claiming platform scope does not verify as one',
  );
  assert.throws(
    () => shop.verify(platform.sign({ sub: 'a1', scope: 'platform' })),
    'a platform token does not verify as a shop token',
  );

  const ok = {
    DATABASE_URL: 'postgresql://localhost:5432/db',
    JWT_SECRET: shopSecret,
    CORS_ORIGIN: 'https://app.example.com',
    NODE_ENV: 'production',
  };
  assert.doesNotThrow(() => validateEnv({ ...ok }), 'PLATFORM_JWT_SECRET is optional');
  assert.doesNotThrow(
    () => validateEnv({ ...ok, PLATFORM_JWT_SECRET: 'p'.repeat(40) }),
    'a real PLATFORM_JWT_SECRET boots',
  );
  for (const [label, value] of [
    ['a placeholder', 'change-me-to-a-long-random-string'],
    ['too short', 'short'],
    ['the same as JWT_SECRET', shopSecret],
  ] as const) {
    assert.throws(
      () => validateEnv({ ...ok, PLATFORM_JWT_SECRET: value }),
      /PLATFORM_JWT_SECRET/,
      `a PLATFORM_JWT_SECRET that is ${label} must not boot`,
    );
  }
}

/**
 * The stored type of a product image comes from its bytes. The extension and
 * the multipart Content-Type are the client's to choose, so trusting either
 * let an HTML page named `x.png` be published as a web page.
 */
function uploadsAreJudgedByTheirBytes() {
  const bytes = (...b: number[]) => Buffer.from(b);
  const ascii = (t: string) => Buffer.from(t, 'latin1');
  assert.deepStrictEqual(
    sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
    { ext: '.png', mime: 'image/png' },
  );
  assert.deepStrictEqual(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), {
    ext: '.jpg',
    mime: 'image/jpeg',
  });
  assert.deepStrictEqual(sniffImage(ascii('GIF89a....')), { ext: '.gif', mime: 'image/gif' });
  assert.deepStrictEqual(sniffImage(ascii('RIFF\0\0\0\0WEBPVP8 ')), {
    ext: '.webp',
    mime: 'image/webp',
  });
  for (const [label, buf] of [
    ['an HTML page', ascii('<!doctype html><script>alert(1)</script>')],
    ['an SVG', ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['a RIFF that is not WebP', ascii('RIFF\0\0\0\0WAVEfmt ')],
    ['a truncated PNG header', bytes(0x89, 0x50, 0x4e)],
    ['an empty file', Buffer.alloc(0)],
  ] as const) {
    assert.strictEqual(sniffImage(buf), null, `${label} is not accepted as an image`);
  }
}

/**
 * Free text is bounded. The body limit is 1mb (8mb on the import), and names
 * had a MinLength but no MaxLength, so a multi-megabyte customer name used to
 * be accepted and stored.
 */
async function freeTextIsBounded() {
  const errorsFor = async <T extends object>(cls: new () => T, body: object) =>
    validate(plainToInstance(cls, body), { whitelist: true });

  assert.strictEqual(
    (await errorsFor(CreateCustomerDto, { name: 'Ram Bahadur' })).length,
    0,
    'an ordinary name passes',
  );
  const long = await errorsFor(CreateCustomerDto, { name: 'x'.repeat(201) });
  assert.ok(
    long.some((e) => e.property === 'name' && e.constraints?.maxLength),
    'a 201-character customer name is refused',
  );

  const sale = await errorsFor(CreateSaleDto, {
    note: 'n'.repeat(1001),
    items: [{ productId: 'p1', quantity: 1, serials: ['s'.repeat(101)] }],
  });
  assert.ok(
    sale.some((e) => e.property === 'note'),
    'an oversized sale note is refused',
  );
  assert.ok(
    sale.some((e) => e.property === 'items'),
    'an oversized serial inside a nested line is refused too',
  );
}

/**
 * A bad upload is the client's fault. Nest maps multer errors by message and
 * multer 2.x renamed some, so an upload under the wrong field name answered
 * 500. Uses multer's own error class, so a later multer that changes its
 * shape fails here rather than in production.
 */
function uploadErrorsAreClientErrors() {
  // multer ships no types; this is the one constructor the check needs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MulterError } = require('multer') as {
    MulterError: new (code: string, field?: string) => Error;
  };
  const unexpected = multerErrorToHttp(new MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
  assert.ok(unexpected instanceof BadRequestException, 'wrong field name is a 400');
  assert.match(String(unexpected.message), /"file"/, 'and names the field that was sent');
  assert.ok(
    multerErrorToHttp(new MulterError('LIMIT_FILE_SIZE')) instanceof PayloadTooLargeException,
    'an oversized image is a 413',
  );
  assert.ok(
    multerErrorToHttp(new MulterError('INVALID_FIELD_NAME')) instanceof BadRequestException,
    'codes Nest has never heard of are 400s too',
  );
  assert.strictEqual(multerErrorToHttp(new Error('boom')), null, 'other errors are left alone');
  assert.strictEqual(multerErrorToHttp('nope'), null, 'as are non-errors');
}

/**
 * The daily emails go out at the shop's own 8am / 9am, from a job that runs
 * every quarter hour -- so exactly one run a day must match, including in
 * Nepal, whose +5:45 offset an hourly job at :00 UTC could never hit.
 */
function dailyJobsFireAtShopTime() {
  const ktm = 'Asia/Kathmandu';
  // 08:00 in Kathmandu is 02:15 UTC.
  assert.ok(isLocalSlot(ktm, new Date('2026-09-25T02:15:00Z'), 8), '08:00 Nepal matches');
  assert.ok(!isLocalSlot(ktm, new Date('2026-09-25T02:00:00Z'), 8), '07:45 Nepal does not');
  assert.ok(!isLocalSlot(ktm, new Date('2026-09-25T02:30:00Z'), 8), '08:15 Nepal is the next slot');
  assert.ok(!isLocalSlot(ktm, new Date('2026-09-25T08:00:00Z'), 8), 'the server\'s 08:00 is 13:45 there');

  // Walk one whole day of quarter-hour runs: each zone matches exactly once.
  for (const tz of [ktm, 'UTC', 'Asia/Kolkata', 'America/New_York']) {
    let hits = 0;
    for (let q = 0; q < 96; q++) {
      if (isLocalSlot(tz, new Date(Date.UTC(2026, 8, 25) + q * 15 * 60_000), 8)) hits++;
    }
    assert.strictEqual(hits, 1, `${tz}: one digest a day`);
  }

  // A zone Intl doesn't know falls back to Nepal rather than throwing.
  assert.ok(isLocalSlot('Not/AZone', new Date('2026-09-25T02:15:00Z'), 8));
}

/**
 * `?activeOnly=false` must mean false. The ValidationPipe's implicit
 * conversion turns the string into `Boolean('false')` -- true -- before a
 * `@Transform` sees `value`, so the flag was silently inverted and a purchase
 * line on a deactivated product could not be looked up.
 */
function queryFlagsMeanWhatTheySay() {
  const parse = (q: object) =>
    plainToInstance(QueryProductDto, q, { enableImplicitConversion: true });
  const off = parse({ activeOnly: 'false', excludeVariants: 'false', trackSerials: 'false' });
  assert.strictEqual(off.activeOnly, false, "'false' is false");
  assert.strictEqual(off.excludeVariants, false);
  assert.strictEqual(off.trackSerials, false);
  const on = parse({ activeOnly: 'true', trackSerials: true });
  assert.strictEqual(on.activeOnly, true);
  assert.strictEqual(on.trackSerials, true);
  // Left out, a flag stays unset, so the service's defaults still apply.
  assert.strictEqual(parse({}).activeOnly, undefined);
}

/**
 * `taxInclusive` was stored and editable but pricing always added tax on
 * top. With it on, the shelf price is what the customer pays: the tax is
 * backed out of it, and the sale remembers which way it was priced.
 */
async function inclusivePricesContainTheirTax() {
  // The split itself: 113 at 13% is 100 + 13, and net + tax is always the
  // shelf price even where the tax rounds.
  assert.deepStrictEqual(splitTax(113, 13, true), { net: 100, tax: 13, total: 113 });
  assert.deepStrictEqual(splitTax(100, 13, false), { net: 100, tax: 13, total: 113 });
  const odd = splitTax(100, 13, true);
  assert.strictEqual(odd.tax, 11.5);
  assert.strictEqual(Math.round((odd.net + odd.tax) * 100) / 100, 100);
  assert.deepStrictEqual(splitTax(50, 0, true), { net: 50, tax: 0, total: 50 });

  const products = [
    { id: 'p1', name: 'Soap', sellingPrice: 113, costPrice: 60, taxRate: 13, isTaxable: true, isActive: true },
    { id: 'p2', name: 'Rice', sellingPrice: 50, costPrice: 40, taxRate: 13, isTaxable: false, isActive: true },
  ];
  const holdWith = async (taxInclusive: boolean) => {
    let saved: any = null;
    const prisma = stub<PrismaService>({
      store: { findFirst: async () => ({ id: 's1' }) },
      business: { findUnique: async () => ({ taxEnabled: true, taxInclusive }) },
      product: { findMany: async () => products },
      sale: {
        create: async ({ data }: any) => {
          saved = data;
          return data;
        },
      },
    });
    const service = new SalesService(
      prisma,
      stub<InventoryService>({}),
      stub<MailService>({}),
      stub<ShiftsService>({}),
      stub<PaymentsService>({}),
    );
    await service.hold(user, {
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ],
    } as any);
    return saved;
  };

  const incl = await holdWith(true);
  assert.strictEqual(incl.taxInclusive, true, 'the sale snapshots how it was priced');
  assert.strictEqual(incl.total, 276, 'the customer pays the shelf prices, 2 x 113 + 50');
  assert.strictEqual(incl.tax, 26);
  assert.strictEqual(incl.subtotal, 250);
  assert.strictEqual(incl.items.create[0].lineTotal, 226);
  assert.strictEqual(incl.items.create[1].lineTotal, 50, 'untaxed lines are untouched');

  const excl = await holdWith(false);
  assert.strictEqual(excl.taxInclusive, false);
  assert.strictEqual(excl.subtotal, 276);
  assert.strictEqual(excl.tax, 29.38, 'tax on top, as before');
  assert.strictEqual(excl.total, 305.38);
}

/**
 * Admin roles (FEATURES.md section 4): SUPPORT reads, and writes only where
 * a route says so; the panel always keeps one active full ADMIN.
 */
async function supportAdminsAreReadOnly() {
  const S = PlatformRole.SUPPORT;
  assert.ok(platformRoleAllows(S, 'GET', {}), 'support can read');
  assert.ok(!platformRoleAllows(S, 'POST', {}), 'support cannot write by default');
  assert.ok(!platformRoleAllows(S, 'DELETE', {}));
  assert.ok(platformRoleAllows(S, 'POST', { supportMayWrite: true }), 'unless the route allows it');
  assert.ok(!platformRoleAllows(S, 'GET', { adminOnly: true }), 'and never an admin-only read');
  assert.ok(platformRoleAllows(PlatformRole.ADMIN, 'DELETE', { adminOnly: true }), 'admins can do anything');

  const admins: any[] = [
    { id: 'a1', email: 'a1@x.com', isActive: true, role: PlatformRole.ADMIN },
    { id: 's1', email: 's1@x.com', isActive: true, role: PlatformRole.SUPPORT },
  ];
  const prisma = stub<PrismaService>({
    platformAdmin: {
      findUnique: async ({ where }: any) => admins.find((a) => a.id === where.id) ?? null,
      count: async ({ where }: any) =>
        admins.filter(
          (a) => a.isActive && a.id !== where.id.not && (!where.role || a.role === where.role),
        ).length,
      update: async ({ where, data }: any) => Object.assign(admins.find((a) => a.id === where.id)!, data),
    },
  });
  const service = new PlatformAdminsService(prisma, stub<PlatformAuditService>({ record: async () => {} }));
  const a1 = { adminId: 'a1', email: 'a1@x.com' };
  const s1 = { adminId: 's1', email: 's1@x.com' };

  await assert.rejects(service.update(a1, 'a1', { role: PlatformRole.SUPPORT }), /your own role/);
  // An active support account doesn't count: demoting or deactivating the
  // only full admin would leave nobody able to create another.
  await assert.rejects(service.update(s1, 'a1', { role: PlatformRole.SUPPORT }), /full admin must remain/);
  await assert.rejects(service.update(s1, 'a1', { isActive: false }), /full admin must remain/);
  // Promote s1, and then a1 can step down.
  await service.update(a1, 's1', { role: PlatformRole.ADMIN });
  await service.update(s1, 'a1', { role: PlatformRole.SUPPORT });
  assert.strictEqual(admins[0].role, PlatformRole.SUPPORT);
}

/** Invite-only signup refuses the public form; the trial length follows the setting. */
async function signupFollowsThePlatformSettings() {
  const withSettings = (row: Partial<{ signupOpen: boolean; trialDays: number | null }>) => {
    const prisma = stub<PrismaService>({
      platformSettings: {
        upsert: async () => ({ id: 1, signupOpen: true, trialDays: null, ...row }),
      },
    });
    return new SettingsService(prisma);
  };
  const closed = new AuthService(
    stub<PrismaService>({}),
    stub<JwtService>({}),
    stub<MailService>({}),
    stub<AuditService>({}),
    stub<PrincipalCache>({}),
    withSettings({ signupOpen: false }),
  );
  await assert.rejects(
    closed.register({ email: 'x@y.com', password: 'password123', name: 'X', businessName: 'Shop' } as any),
    (e: any) => e.getResponse?.().code === 'SIGNUP_CLOSED',
    'a closed signup is refused before anything is written',
  );

  const saved = process.env.TRIAL_DAYS;
  process.env.TRIAL_DAYS = '21';
  try {
    assert.strictEqual(await withSettings({}).trialDays(), 21, 'unset falls back to env TRIAL_DAYS');
    assert.strictEqual(await withSettings({ trialDays: 30 }).trialDays(), 30, 'the setting wins');
    assert.strictEqual(await withSettings({ trialDays: 0 }).trialDays(), 0, 'zero is a real value');
  } finally {
    if (saved === undefined) delete process.env.TRIAL_DAYS;
    else process.env.TRIAL_DAYS = saved;
  }
}

/** Retention deletes only entries past the cut-off, and nothing when it's off. */
async function logRetentionRemovesOnlyOldEntries() {
  const now = new Date('2026-09-24T00:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;
  let rows = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, createdAt: new Date(now.getTime() - i * 30 * DAY) }));
  const prisma = stub<PrismaService>({
    auditLog: {
      findMany: async ({ where, take }: any) =>
        rows.filter((r) => r.createdAt < where.createdAt.lt).slice(0, take).map((r) => ({ id: r.id })),
      deleteMany: async ({ where }: any) => {
        const before = rows.length;
        rows = rows.filter((r) => !where.id.in.includes(r.id));
        return { count: before - rows.length };
      },
    },
  });
  const cronWith = (auditRetentionDays: number | null) =>
    new LogRetentionCron(prisma, stub<SettingsService>({ get: async () => ({ auditRetentionDays }) }));

  assert.strictEqual(await cronWith(null).run(now), 'retention off');
  assert.strictEqual(rows.length, 12, 'off means nothing is removed');
  await cronWith(90).run(now);
  // Ages 0, 30, 60, 90 days are kept (90 is not older than the cut-off).
  assert.deepStrictEqual(rows.map((r) => r.id), ['l0', 'l1', 'l2', 'l3']);
}

/** In the shop, owners and managers see every ticket; other staff only their own. */
async function staffSeeOnlyTheirOwnTickets() {
  const wheres: any[] = [];
  const prisma = stub<PrismaService>({
    supportTicket: {
      findMany: async ({ where }: any) => {
        wheres.push(where);
        return [];
      },
      count: async () => 0,
    },
  });
  const service = new SupportService(prisma, stub<MailService>({}), stub<PlatformAuditService>({}));
  const q = Object.assign(new QueryTicketsDto(), { page: 1, limit: 20 });
  await service.listForShop({ ...user, role: UserRole.CASHIER }, q);
  await service.listForShop({ ...user, role: UserRole.OWNER }, q);
  assert.deepStrictEqual(wheres[0], { businessId: 'b1', userId: 'u1' }, 'a cashier sees their own');
  assert.deepStrictEqual(wheres[1], { businessId: 'b1' }, 'an owner sees the whole business');
}

async function main() {
  subscriptionRules();
  dailyJobsFireAtShopTime();
  queryFlagsMeanWhatTheySay();
  subscriptionGraceAndSummary();
  adminTotpMatchesTheRfc();
  await adminTotpLocksAfterRepeatedWrongCodes();
  await viewAsOwnerIsReadOnly();
  await adminCannotLockOutThePanel();
  await reminderGoesOutOncePerThreshold();
  await aNotificationIsReadPerPerson();
  await renewalsAndReceipts();
  await onboardingFlagsTheStuckShops();
  await announcementsScheduleAndTarget();
  await supportTicketsGetAnOwner();
  await shiftReportBalancesTheDrawer();
  await cashControlOnAShift();
  await oneDrawerOneShift();
  await everyPaymentLeavesATrail();
  await aStatementCountsAReturnOnce();
  await theLastActiveStoreStaysOpen();
  await aCategoryCannotBecomeItsOwnAncestor();
  await anOwnerJoinsTheTillAlreadyOpen();
  await stockTakePreviewComputesVariances();
  await reorderSuggestionsGroupBySupplier();
  await variantGenerationCoversEveryCombination();
  await serialRulesGuardEveryUnit();
  await unitsGovernFractionalQuantities();
  await partReturnLeavesTheSalePartiallyReturned();
  await aHeldCartCannotBeReturned();
  await aReturnGivesBackWhatWasPaidNotTheShelfPrice();
  await aReturnCancelsOnlyCreditStillOwed();
  await aReturnPreviewMatchesTheReturn();
  await aSupplierRefundIsOwedUntilReceived();
  await damagedReturnsAreWrittenOff();
  await aPinnedCashierReturnsOnlyAtTheirStore();
  await aProductChargesTheTaxItShows();
  await aPartPaymentKeepsItsTender();
  await aCustomerWithHistoryIsKept();
  await creditAgeingCountsAReturnOnce();
  await aStaleReadCannotOverReturnALine();
  await verifyEmailAlwaysRequiresTheCode();
  envValidationRefusesUnsafeConfig();
  platformTokensUseTheirOwnKey();
  uploadsAreJudgedByTheirBytes();
  uploadErrorsAreClientErrors();
  await freeTextIsBounded();
  await principalCacheCannotResurrectARetiredToken();
  await permanentDeleteRefusesToDestroyHistory();
  staffCannotReachAnotherStore();
  await productStoresCannotSilentlyWriteOffStock();
  await anAdminPasswordResetEndsTheirSessions();
  await aNewStoreOpensCarryingTheCatalog();
  await inclusivePricesContainTheirTax();
  await supportAdminsAreReadOnly();
  await signupFollowsThePlatformSettings();
  await logRetentionRemovesOnlyOldEntries();
  await staffSeeOnlyTheirOwnTickets();
  console.log('checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
