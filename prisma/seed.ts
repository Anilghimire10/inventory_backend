import {
  PrismaClient,
  BusinessType,
  UserRole,
  PaymentMethod,
  SaleStatus,
  PurchaseStatus,
  StockMovementType,
} from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * Seeds a platform super-admin and one demo business with a rich dummy dataset
 * (categories, products, suppliers, customers, purchases, sales, batches).
 * Login: owner@demo.com / password123
 */
async function main() {
  // ---- Platform super-admin (idempotent) ----
  const adminEmail = process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.com';
  const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? 'admin12345';
  const adminExists = await prisma.platformAdmin.findUnique({
    where: { email: adminEmail },
  });
  if (!adminExists) {
    await prisma.platformAdmin.create({
      data: {
        email: adminEmail,
        name: 'Platform Admin',
        passwordHash: await argon2.hash(adminPassword),
      },
    });
    console.log(`Platform admin created: ${adminEmail} / ${adminPassword}`);
  }

  // ---- Demo business (idempotent) ----
  const email = 'owner@demo.com';
  let owner = await prisma.user.findUnique({ where: { email } });
  let business = owner ? await prisma.business.findUnique({ where: { id: owner.businessId } }) : null;

  if (!business) {
    const passwordHash = await argon2.hash('password123');
    business = await prisma.business.create({
      data: { name: 'Demo Store', type: BusinessType.RETAIL, currency: 'USD', taxEnabled: true },
    });
    const store = await prisma.store.create({
      data: { businessId: business.id, name: 'Main Store', phone: '555-0100' },
    });
    owner = await prisma.user.create({
      data: {
        businessId: business.id,
        storeId: store.id,
        email,
        name: 'Demo Owner',
        passwordHash,
        role: UserRole.OWNER,
        emailVerified: true,
      },
    });
  } else {
    // Re-resolve the demo store (first active store in the business).
    const store = await prisma.store.findFirst({
      where: { businessId: business.id },
      orderBy: { createdAt: 'asc' },
    });
    if (!store) {
      throw new Error('Demo business has no store — run a clean migration first.');
    }
  }

  // Already seeded with the rich dummy dataset? Then bail out.
  const marker = await prisma.category.findFirst({
    where: { businessId: business.id, name: 'Beverages' },
  });
  if (marker) {
    console.log('Demo dummy data already seeded. Skipping.');
    console.log('  Login: owner@demo.com / password123');
    return;
  }

  const store = await prisma.store.findFirst({
    where: { businessId: business.id },
    orderBy: { createdAt: 'asc' },
  });
  if (!store) throw new Error('No store found for demo business');
  const bid = business.id;
  const sid = store.id;

  // ---- Taxes ----
  const vat = await prisma.tax.create({
    data: { businessId: bid, name: 'VAT 13%', rate: 13, isDefault: true },
  });

  // ---- Categories (get-or-create by name, never duplicate) ----
  const categoryNames = [
    'Beverages',
    'Snacks',
    'Dairy & Eggs',
    'Bakery',
    'Cleaning & Home',
    'Health & Pharmacy',
    'Personal Care',
    'General',
  ];
  const categories: Record<string, string> = {};
  for (const name of categoryNames) {
    const existing = await prisma.category.findFirst({ where: { businessId: bid, name } });
    if (existing) {
      categories[name] = existing.id;
      continue;
    }
    const c = await prisma.category.create({ data: { businessId: bid, name } });
    categories[name] = c.id;
  }

  // ---- Products ----
  // [name, category, sku, barcode, unit, cost, price, reorderLevel, opts]
  const productDefs: Array<[string, string, string, string, string, number, number, number, Partial<{ rx: boolean; batch: boolean; taxable: boolean; brand: string; desc: string }>]> = [
    ['Coca-Cola 500ml', 'Beverages', 'BEV-001', '8901030812345', 'pcs', 0.45, 1.0, 40, { brand: 'Coca-Cola' }],
    ['Pepsi 500ml', 'Beverages', 'BEV-002', '8901030812346', 'pcs', 0.4, 0.9, 40, { brand: 'Pepsi' }],
    ['Mineral Water 1L', 'Beverages', 'BEV-003', '8901030812347', 'pcs', 0.2, 0.5, 60, { brand: 'Aquafina' }],
    ['Orange Juice 1L', 'Beverages', 'BEV-004', '8901030812348', 'pcs', 1.2, 2.4, 25, { brand: 'Real' }],
    ['Potato Chips 100g', 'Snacks', 'SNK-001', '8901030812349', 'pcs', 0.6, 1.2, 50, { brand: 'Lay\'s' }],
    ['Chocolate Bar 60g', 'Snacks', 'SNK-002', '8901030812350', 'pcs', 0.8, 1.5, 45, { brand: 'Cadbury' }],
    ['Biscuits Family Pack', 'Snacks', 'SNK-003', '8901030812351', 'pcs', 1.1, 2.0, 35, { brand: 'Parle' }],
    ['Whole Milk 1L', 'Dairy & Eggs', 'DRY-001', '8901030812352', 'pcs', 0.7, 1.3, 30, { batch: true, brand: 'Dairyland' }],
    ['Cheddar Cheese 200g', 'Dairy & Eggs', 'DRY-002', '8901030812353', 'pcs', 2.5, 4.5, 20, { batch: true, brand: 'Kraft' }],
    ['Eggs (12)', 'Dairy & Eggs', 'DRY-003', '8901030812354', 'tray', 1.8, 3.0, 30, { batch: true }],
    ['White Bread 400g', 'Bakery', 'BKY-001', '8901030812355', 'pcs', 0.5, 1.0, 25, { batch: true }],
    ['Croissant (2-pack)', 'Bakery', 'BKY-002', '8901030812356', 'pcs', 1.0, 2.0, 20, { batch: true }],
    ['Dish Soap 500ml', 'Cleaning & Home', 'CLN-001', '8901030812357', 'pcs', 1.3, 2.5, 15, { brand: 'Vim' }],
    ['Laundry Detergent 2kg', 'Cleaning & Home', 'CLN-002', '8901030812358', 'pcs', 4.0, 7.5, 10, { brand: 'Ariel' }],
    ['Paracetamol 500mg', 'Health & Pharmacy', 'PHM-001', '8901030812359', 'strip', 0.5, 1.2, 50, { rx: false, batch: true, brand: 'GSK' }],
    ['Amoxicillin 250mg', 'Health & Pharmacy', 'PHM-002', '8901030812360', 'strip', 1.5, 3.5, 30, { rx: true, batch: true, brand: 'Cipla' }],
    ['Multivitamin Tablets', 'Health & Pharmacy', 'PHM-003', '8901030812361', 'bottle', 3.0, 6.0, 20, { rx: false, batch: true, brand: 'Centrum' }],
    ['Toothpaste 100g', 'Personal Care', 'PRS-001', '8901030812362', 'pcs', 1.0, 2.2, 25, { brand: 'Colgate' }],
    ['Shampoo 200ml', 'Personal Care', 'PRS-002', '8901030812363', 'pcs', 2.2, 4.0, 15, { brand: 'Pantene' }],
    ['Hand Sanitizer 250ml', 'Personal Care', 'PRS-003', '8901030812364', 'pcs', 1.1, 2.0, 20, { brand: 'Dettol' }],
    ['Universal Charger 20W', 'General', 'GEN-001', '8901030812365', 'pcs', 3.5, 8.0, 8, { brand: 'Anker' }],
    ['LED Bulb 9W', 'General', 'GEN-002', '8901030812366', 'pcs', 1.5, 3.5, 20, { brand: 'Philips' }],
  ];

  const products: Record<string, string> = {};
  for (const [name, cat, sku, barcode, unit, cost, price, reorder, opts] of productDefs) {
    const p = await prisma.product.create({
      data: {
        businessId: bid,
        name,
        description: opts.desc,
        sku,
        barcode,
        unit,
        costPrice: cost,
        sellingPrice: price,
        brand: opts.brand,
        isRxRequired: opts.rx ?? false,
        trackBatches: opts.batch ?? false,
        taxId: vat.id,
        taxRate: vat.rate,
        reorderLevel: reorder,
        categories: { connect: { id: categories[cat] } },
      },
    });
    products[name] = p.id;
  }

  // Low-stock products (below reorder level) — triggers LOW_STOCK notifications.
  const stockQty: Record<string, number> = {
    'BEV-001': 25,
    'BEV-002': 30,
    'BEV-003': 80,
    'BEV-004': 12,
    'SNK-001': 40,
    'SNK-002': 60,
    'SNK-003': 5,
    'DRY-001': 18,
    'DRY-002': 6,
    'DRY-003': 40,
    'BKY-001': 8,
    'BKY-002': 14,
    'CLN-001': 30,
    'CLN-002': 4,
    'PHM-001': 90,
    'PHM-002': 22,
    'PHM-003': 28,
    'PRS-001': 35,
    'PRS-002': 10,
    'PRS-003': 45,
    'GEN-001': 3,
    'GEN-002': 25,
  };
  for (const [sku, qty] of Object.entries(stockQty)) {
    const product = await prisma.product.findFirst({ where: { businessId: bid, sku } });
    if (!product) continue;
    await prisma.stockItem.create({
      data: { businessId: bid, storeId: sid, productId: product.id, quantity: qty },
    });
  }

  // ---- Batches (for batch-tracked products) ----
  const now = new Date();
  const batchDefs: Array<[string, string, number, number]> = [
    // [sku, batchNumber, quantity, daysFromNowForExpiry]
    ['DRY-001', 'MILK-B-001', 18, 9],
    ['DRY-002', 'CHS-B-001', 6, 21],
    ['DRY-003', 'EGG-B-001', 40, 14],
    ['BKY-001', 'BRD-B-001', 8, 4],
    ['BKY-002', 'CRO-B-001', 14, 6],
    ['PHM-001', 'PCM-B-001', 90, 180],
    ['PHM-002', 'AMX-B-001', 22, 60],
    ['PHM-003', 'MVT-B-001', 28, 300],
  ];
  for (const [sku, batchNo, qty, days] of batchDefs) {
    const product = await prisma.product.findFirst({ where: { businessId: bid, sku } });
    if (!product) continue;
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + days);
    await prisma.batch.create({
      data: {
        businessId: bid,
        storeId: sid,
        productId: product.id,
        batchNumber: batchNo,
        expiryDate: expiry,
        quantity: qty,
        costPrice: product.costPrice,
      },
    });
  }

  // ---- Suppliers ----
  const supplierDefs: Array<[string, string, string, string, string]> = [
    ['Beverages Nepal Pvt. Ltd.', 'Ramesh Shrestha', '9801-000001', 'sales@beveragesnepal.com', 'Baneshwor, Kathmandu'],
    ['Green Valley Agro', 'Sunita Tamang', '9801-000002', 'orders@greenvalley.com', 'Hetauda, Bagmati'],
    ['Nepal Distributors Co.', 'Bikash KC', '9801-000003', 'info@nepaldist.com', 'Kalanki, Kathmandu'],
    ['HealthCare Pharma Supplies', 'Dr. Anil Maharjan', '9801-000004', 'supply@healthcarepharma.com', 'Thapathali, Kathmandu'],
    ['Home Essentials Traders', 'Priya Rai', '9801-000005', 'hello@homeessentials.com', 'Balkumari, Lalitpur'],
  ];
  for (const [name, contact, phone, em, addr] of supplierDefs) {
    await prisma.supplier.create({
      data: { businessId: bid, name, contactName: contact, phone, email: em, address: addr },
    });
  }
  const suppliers = await prisma.supplier.findMany({ where: { businessId: bid } });

  // ---- Customers ----
  const customerDefs: Array<[string, string, string | null, number]> = [
    ['Sita Gurung', '9841-000001', 'sita.g@example.com', 0],
    ['Ram Bahadur Thapa', '9841-000002', null, 125.5],
    ['Maya Sharma', '9841-000003', 'maya.s@example.com', 0],
    ['Krishna Limbu', '9841-000004', null, 480.0],
    ['Anita Maharjan', '9841-000005', 'anita.m@example.com', 0],
    ['Deepak Adhikari', '9841-000006', null, 65.0],
    ['Puja Karki', '9841-000007', 'puja.k@example.com', 0],
    ['Rajan Shrestha', '9841-000008', null, 0],
  ];
  for (const [name, phone, em, credit] of customerDefs) {
    await prisma.customer.create({
      data: { businessId: bid, name, phone, email: em, creditBalance: credit },
    });
  }
  const customers = await prisma.customer.findMany({ where: { businessId: bid } });

  // ---- Purchases (RECEIVED) ----
  const purchaseDefs: Array<[string, string, number, Array<[string, number, number]>]> = [
    // [supplierName, purchaseReference, daysAgo, [sku, qty, cost]]
    [
      'Beverages Nepal Pvt. Ltd.',
      'PO-24001',
      20,
      [
        ['BEV-001', 100, 0.4],
        ['BEV-002', 100, 0.35],
        ['BEV-003', 150, 0.18],
        ['BEV-004', 60, 1.1],
      ],
    ],
    [
      'Green Valley Agro',
      'PO-24002',
      15,
      [
        ['DRY-001', 80, 0.6],
        ['DRY-002', 50, 2.2],
        ['DRY-003', 120, 1.6],
        ['BKY-001', 60, 0.45],
        ['BKY-002', 40, 0.9],
      ],
    ],
    [
      'Nepal Distributors Co.',
      'PO-24003',
      10,
      [
        ['SNK-001', 100, 0.5],
        ['SNK-002', 80, 0.7],
        ['SNK-003', 60, 1.0],
        ['CLN-001', 50, 1.2],
        ['CLN-002', 30, 3.8],
      ],
    ],
    [
      'HealthCare Pharma Supplies',
      'PO-24004',
      8,
      [
        ['PHM-001', 200, 0.4],
        ['PHM-002', 80, 1.3],
        ['PHM-003', 60, 2.8],
      ],
    ],
    [
      'Home Essentials Traders',
      'PO-24005',
      5,
      [
        ['PRS-001', 60, 0.9],
        ['PRS-002', 40, 2.0],
        ['PRS-003', 70, 1.0],
        ['GEN-001', 25, 3.2],
        ['GEN-002', 40, 1.4],
      ],
    ],
  ];

  const purchaseTotals: Record<string, { subtotal: number; tax: number; total: number }> = {};
  for (const [supplierName, ref, daysAgo, items] of purchaseDefs) {
    const supplier = suppliers.find((s) => s.name === supplierName);
    const createdAt = new Date(now);
    createdAt.setDate(createdAt.getDate() - daysAgo);
    const receivedAt = new Date(createdAt);
    receivedAt.setDate(receivedAt.getDate() + 1);

    const itemRows: Array<{
      productId: string;
      quantity: number;
      costPrice: number;
      batchNumber: string | null;
      expiryDate: Date | null;
    }> = [];
    let subtotal = 0;
    for (const [sku, qty, cost] of items) {
      const product = await prisma.product.findFirst({ where: { businessId: bid, sku } });
      if (!product) continue;
      subtotal += qty * cost;
      itemRows.push({
        productId: product.id,
        quantity: qty,
        costPrice: cost,
        batchNumber: product.trackBatches ? `${sku.split('-')[0]}-B` : null,
        expiryDate: product.trackBatches
          ? (() => {
              const d = new Date(now);
              d.setDate(d.getDate() + 90);
              return d;
            })()
          : null,
      });
    }
    const tax = Math.round(subtotal * 0.13 * 100) / 100;
    const total = subtotal + tax;

    const purchase = await prisma.purchase.create({
      data: {
        businessId: bid,
        storeId: sid,
        supplierId: supplier?.id,
        reference: ref,
        status: PurchaseStatus.RECEIVED,
        subtotal,
        tax,
        total,
        amountPaid: total,
        receivedAt,
        createdAt,
        items: { create: itemRows },
      },
    });

    for (const [sku, qty] of items) {
      const product = await prisma.product.findFirst({ where: { businessId: bid, sku } });
      if (!product) continue;
      await prisma.stockItem.updateMany({
        where: { storeId: sid, productId: product.id },
        data: { quantity: { increment: qty } },
      });
      await prisma.stockMovement.create({
        data: {
          businessId: bid,
          storeId: sid,
          productId: product.id,
          userId: owner?.id,
          type: StockMovementType.PURCHASE,
          quantity: qty,
          note: `Purchase ${ref}`,
          reference: purchase.id,
          createdAt,
        },
      });
    }
    purchaseTotals[ref] = { subtotal, tax, total };
  }

  // ---- Sales over the last 30 days ----
  const productList = await prisma.product.findMany({
    where: { businessId: bid },
    include: { stockItems: { where: { storeId: sid } } },
  });

  // receiptNo starting after any existing receipts
  const existingSales = await prisma.sale.findMany({
    where: { businessId: bid },
    select: { receiptNo: true },
  });
  let receiptCounter = 1000 + existingSales.length + 1;

  const methods: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.MOBILE];
  const rng = (seed: number) => {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  };

  const rand = rng(20240818);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

  for (let i = 0; i < 60; i++) {
    const daysAgo = Math.floor(rand() * 30);
    const hour = 8 + Math.floor(rand() * 12);
    const createdAt = new Date(now);
    createdAt.setDate(createdAt.getDate() - daysAgo);
    createdAt.setHours(hour, Math.floor(rand() * 60), 0, 0);

    const itemCount = 1 + Math.floor(rand() * 5);
    const chosen: typeof productList = [];
    const seen = new Set<number>();
    for (let j = 0; j < itemCount; j++) {
      let idx = Math.floor(rand() * productList.length);
      while (seen.has(idx)) idx = Math.floor(rand() * productList.length);
      seen.add(idx);
      chosen.push(productList[idx]);
    }

    // 85% COMPLETED, 10% HELD, 5% RETURNED
    const roll = rand();
    const status: SaleStatus =
      roll < 0.85 ? SaleStatus.COMPLETED : roll < 0.95 ? SaleStatus.HELD : SaleStatus.RETURNED;

    const isCredit = rand() < 0.15 && status === SaleStatus.COMPLETED;
    const method: PaymentMethod = isCredit
      ? PaymentMethod.CREDIT
      : status === SaleStatus.COMPLETED
        ? pick(methods)
        : PaymentMethod.CASH;

    const customer = pick(customers);
    let subtotal = 0;
    const saleItems: Array<{
      productId: string;
      name: string;
      quantity: number;
      unitPrice: number;
      unitCost: number;
      discount: number;
      taxRate: number;
      lineTotal: number;
    }> = [];

    for (const product of chosen) {
      const qty = 1 + Math.floor(rand() * 4);
      const unitPrice = Number(product.sellingPrice);
      const unitCost = Number(product.costPrice);
      const discount = status === SaleStatus.COMPLETED && rand() < 0.2 ? 0.5 : 0;
      const lineTotal = qty * unitPrice - discount;
      subtotal += lineTotal;
      saleItems.push({
        productId: product.id,
        name: product.name,
        quantity: qty,
        unitPrice,
        unitCost,
        discount,
        taxRate: Number(product.taxRate),
        lineTotal,
      });

      // stock movement (skip for HELD / RETURNED — no stock leaves)
      if (status === SaleStatus.COMPLETED) {
        await prisma.stockItem.updateMany({
          where: { storeId: sid, productId: product.id },
          data: { quantity: { decrement: qty } },
        });
        await prisma.batch.updateMany({
          where: { storeId: sid, productId: product.id, quantity: { gte: qty } },
          data: { quantity: { decrement: qty } },
        });
      }
    }

    const discountTotal = saleItems.reduce((s, it) => s + it.discount, 0);
    const tax = status === SaleStatus.COMPLETED ? Math.round(subtotal * 0.13 * 100) / 100 : 0;
    const total = Math.round((subtotal - discountTotal + tax) * 100) / 100;
    const amountPaid =
      status !== SaleStatus.COMPLETED || method === PaymentMethod.CREDIT
        ? 0
        : method === PaymentMethod.MIXED
          ? total
          : total;

    const receiptNo = `REC-${receiptCounter++}`;
    const sale = await prisma.sale.create({
      data: {
        businessId: bid,
        storeId: sid,
        userId: owner?.id,
        customerId: customer?.id,
        receiptNo,
        status,
        subtotal,
        discount: discountTotal,
        tax,
        total,
        paymentMethod: method,
        amountPaid,
        prescriptionRef:
          status === SaleStatus.COMPLETED && chosen.some((p) => p.isRxRequired)
            ? `RX-${10000 + Math.floor(rand() * 90000)}`
            : null,
        note: status === SaleStatus.HELD ? 'Held at counter — customer will return.' : null,
        createdAt,
        items: { create: saleItems },
      },
    });

    // stock movements for completed sales
    if (status === SaleStatus.COMPLETED) {
      for (const it of saleItems) {
        await prisma.stockMovement.create({
          data: {
            businessId: bid,
            storeId: sid,
            productId: it.productId,
            userId: owner?.id,
            type: StockMovementType.SALE,
            quantity: -it.quantity,
            note: `Receipt ${receiptNo}`,
            reference: sale.id,
            createdAt,
          },
        });
      }
    }

    // credit sales bump the customer balance
    if (method === PaymentMethod.CREDIT && customer) {
      await prisma.customer.update({
        where: { id: customer.id },
        data: { creditBalance: { increment: total } },
      });
    }
  }

  // ---- A couple of stock adjustments ----
  const adjProduct = await prisma.product.findFirst({ where: { businessId: bid, sku: 'GEN-002' } });
  if (adjProduct) {
    const adjDate = new Date(now);
    adjDate.setDate(adjDate.getDate() - 2);
    await prisma.stockItem.updateMany({
      where: { storeId: sid, productId: adjProduct.id },
      data: { quantity: { decrement: 2 } },
    });
    await prisma.stockMovement.create({
      data: {
        businessId: bid,
        storeId: sid,
        productId: adjProduct.id,
        userId: owner?.id,
        type: StockMovementType.ADJUSTMENT,
        quantity: -2,
        reason: 'COUNT_CORRECTION',
        note: 'Periodic inventory count — 2 bulbs damaged.',
        createdAt: adjDate,
      },
    });
  }

  console.log('Seed complete.');
  console.log('  Login: owner@demo.com / password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
