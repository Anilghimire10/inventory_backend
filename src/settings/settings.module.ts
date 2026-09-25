import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { LogRetentionCron } from './log-retention.cron';

/** Global: signup, the trial, the admin panel and the retention job all read it. */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, LogRetentionCron],
  exports: [SettingsService],
})
export class SettingsModule {}
