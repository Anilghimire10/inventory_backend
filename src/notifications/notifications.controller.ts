import { Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { LowStockCron } from './low-stock.cron';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly lowStockCron: LowStockCron,
  ) {}

  /** Owner-only: send the low-stock digest email right now (for testing/manual sends). */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Post('low-stock-digest')
  async sendLowStockDigest(@CurrentUser() u: AuthUser) {
    const sent = await this.lowStockCron.sendForBusiness(u.businessId);
    return {
      message: sent
        ? 'Low-stock digest sent.'
        : 'No low-stock items right now — nothing sent.',
    };
  }

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.notifications.list(u.businessId);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() u: AuthUser) {
    return this.notifications.markAllRead(u.businessId);
  }

  @Post(':id/read')
  markRead(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.notifications.markRead(u.businessId, id);
  }

  @Delete(':id')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.notifications.dismiss(u.businessId, id);
  }
}
