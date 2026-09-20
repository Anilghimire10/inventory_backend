import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health.controller';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { validateEnv } from './common/env.validation';
import { RolesGuard } from './common/guards/roles.guard';
import { StoreScopeGuard } from './common/guards/store-scope.guard';

import { AuditModule } from './audit/audit.module';
import { AuditInterceptor } from './audit/audit.interceptor';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PlatformModule } from './platform/platform.module';
import { BusinessModule } from './business/business.module';
import { UsersModule } from './users/users.module';
import { StoresModule } from './stores/stores.module';
import { CategoriesModule } from './categories/categories.module';
import { TaxesModule } from './taxes/taxes.module';
import { ProductsModule } from './products/products.module';
import { InventoryModule } from './inventory/inventory.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { PurchasesModule } from './purchases/purchases.module';
import { CustomersModule } from './customers/customers.module';
import { SalesModule } from './sales/sales.module';
import { ReportsModule } from './reports/reports.module';
import { CreditModule } from './credit/credit.module';
import { ShiftsModule } from './shifts/shifts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Cron scheduling (daily low-stock digest, etc.)
    ScheduleModule.forRoot(),
    // Global rate limiting — tune for prod via THROTTLE_TTL (ms) / THROTTLE_LIMIT.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => [
        {
          // Number(), not a bare get<number>(): the generic is a TypeScript
          // cast, not a conversion, so anything coming from the environment
          // arrives here as a string while claiming to be a number. The
          // throttler stores a block's expiry as `Date.now() + ttl`, and with
          // a string that concatenates instead of adding -- "60000" turned a
          // 60-second block into one ~5.7 million years long, so the first IP
          // to trip the limit stayed blocked until the process restarted.
          // validateEnv() rejects anything that isn't a positive integer, so
          // these cannot quietly become NaN and switch rate limiting off.
          ttl: Number(c.get('THROTTLE_TTL') ?? 60_000),
          limit: Number(c.get('THROTTLE_LIMIT') ?? 120),
        },
      ],
    }),
    PrismaModule,
    AuditModule,
    MailModule,
    AuthModule,
    NotificationsModule,
    PlatformModule,
    BusinessModule,
    UsersModule,
    StoresModule,
    CategoriesModule,
    TaxesModule,
    ProductsModule,
    InventoryModule,
    SuppliersModule,
    PurchasesModule,
    CustomersModule,
    SalesModule,
    ReportsModule,
    CreditModule,
    ShiftsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Rate limiting runs first (before auth/db work).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global auth: every route requires a valid JWT unless marked @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global role enforcement for routes that declare @Roles(...)
    { provide: APP_GUARD, useClass: RolesGuard },
    // Pins cashiers/stock keepers to the store they are assigned to. Runs
    // after RolesGuard so req.user is populated and the role is already known.
    { provide: APP_GUARD, useClass: StoreScopeGuard },
    // Records successful state-changing requests into the audit log.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
