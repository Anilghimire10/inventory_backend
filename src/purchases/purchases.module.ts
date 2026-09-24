import { Module } from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { PurchasesController } from './purchases.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [InventoryModule, PaymentsModule],
  controllers: [PurchasesController],
  providers: [PurchasesService],
})
export class PurchasesModule {}
