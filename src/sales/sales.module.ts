import { Module } from '@nestjs/common';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [InventoryModule, ShiftsModule, PaymentsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
