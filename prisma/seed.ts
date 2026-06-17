import { PrismaClient, BusinessType, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * Seeds a platform super-admin and one demo business.
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
    data: { name: 'Demo Store', type: BusinessType.RETAIL, currency: 'USD' },
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
      emailVerified: true,
    },
  });

  const category = await prisma.category.create({
    data: { businessId: business.id, name: 'General' },
  });

  const productA = await prisma.product.create({
    data: {
      businessId: business.id,
      categories: { connect: { id: category.id } },
      name: 'Sample Product A',
      sku: 'SKU-A-001',
      barcode: '8901234567890',
      unit: 'pcs',
      costPrice: 0.5,
      sellingPrice: 1.2,
      reorderLevel: 20,
    },
  });
  const productB = await prisma.product.create({
    data: {
      businessId: business.id,
      name: 'Sample Product B',
      sku: 'SKU-B-002',
      unit: 'pcs',
      costPrice: 1.0,
      sellingPrice: 2.5,
      reorderLevel: 15,
      trackBatches: true,
    },
  });

  for (const product of [productA, productB]) {
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
