import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { LowStockCron } from './low-stock.cron';
import { AlertSyncCron } from './alert-sync.cron';
import { AlertTrigger } from './alert-trigger';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, LowStockCron, AlertSyncCron, AlertTrigger],
  exports: [NotificationsService],
})
export class NotificationsModule {}
