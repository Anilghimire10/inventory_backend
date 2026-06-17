import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { LowStockCron } from './low-stock.cron';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, LowStockCron],
  exports: [NotificationsService],
})
export class NotificationsModule {}
