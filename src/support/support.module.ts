import { Module } from '@nestjs/common';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { SupportController } from './support.controller';
import { PlatformSupportController } from './platform-support.controller';
import { SupportService } from './support.service';

/**
 * Support tickets, both sides: the shop's endpoints and the admin panel's.
 * The admin routes are guarded by PlatformAuthGuard, whose passport strategy
 * PlatformModule registers.
 */
@Module({
  controllers: [SupportController, PlatformSupportController],
  providers: [SupportService, PlatformAuditService],
})
export class SupportModule {}
