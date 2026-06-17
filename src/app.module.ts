import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { PrismaModule } from './prisma/prisma.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Cron scheduling (daily low-stock digest, etc.)
    ScheduleModule.forRoot(),
    // Global rate limiting — tune for prod via THROTTLE_TTL (ms) / THROTTLE_LIMIT.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => [
        {
          ttl: c.get<number>('THROTTLE_TTL') ?? 60_000,
          limit: c.get<number>('THROTTLE_LIMIT') ?? 120,
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
  ],
  providers: [
    // Rate limiting runs first (before auth/db work).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global auth: every route requires a valid JWT unless marked @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global role enforcement for routes that declare @Roles(...)
    { provide: APP_GUARD, useClass: RolesGuard },
    // Records successful state-changing requests into the audit log.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
