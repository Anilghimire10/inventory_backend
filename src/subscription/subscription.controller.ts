import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { SubscriptionService } from './subscription.service';

/** The shop app's Subscription page. Read-only: payments are recorded by the platform. */
@ApiTags('subscription')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER)
@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscription: SubscriptionService) {}

  @Get()
  overview(@CurrentUser() u: AuthUser) {
    return this.subscription.overview(u.businessId);
  }

  @Get('payments/:id/receipt')
  receipt(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.subscription.receipt(u.businessId, id);
  }
}
