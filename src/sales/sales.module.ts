import { Module } from '@nestjs/common';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { ShiftsModule } from '../shifts/shifts.module';

@Module({
  imports: [InventoryModule, ShiftsModule],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
