import { PrismaClient, BusinessType, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * Seeds one demo pharmacy business so you can log in and click around.
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

  const email = 'owner@demo.com';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log('Demo business already seeded (owner@demo.com exists). Skipping.');
    return;
  }

  const passwordHash = await argon2.hash('password123');

  const business = await prisma.business.create({
    data: { name: 'Demo Pharmacy', type: BusinessType.PHARMACY, currency: 'USD' },
  });
  const store = await prisma.store.create({
    data: { businessId: business.id, name: 'Main Store', phone: '555-0100' },
  });
  await prisma.user.create({
    data: {
      businessId: business.id,
      storeId: store.id,
      email,
      name: 'Demo Owner',
      passwordHash,
      role: UserRole.OWNER,
    },
  });

  const category = await prisma.category.create({
    data: { businessId: business.id, name: 'Pain Relief' },
  });

  const paracetamol = await prisma.product.create({
    data: {
      businessId: business.id,
      categoryId: category.id,
      name: 'Paracetamol 500mg (10 tablets)',
      sku: 'MED-PARA-500',
      barcode: '8901234567890',
      unit: 'strip',
      costPrice: 0.5,
      sellingPrice: 1.2,
      taxRate: 0,
      reorderLevel: 20,
      trackBatches: true,
    },
  });
  const amoxicillin = await prisma.product.create({
    data: {
      businessId: business.id,
      name: 'Amoxicillin 250mg',
      sku: 'MED-AMOX-250',
      unit: 'strip',
      costPrice: 1.0,
      sellingPrice: 2.5,
      reorderLevel: 15,
      isRxRequired: true,
      trackBatches: true,
    },
  });

  // Open with some stock
  for (const product of [paracetamol, amoxicillin]) {
    await prisma.stockItem.create({
      data: {
        businessId: business.id,
        storeId: store.id,
        productId: product.id,
        quantity: 100,
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
