import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ReportsService } from './reports.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    return this.reports.dashboard(u.businessId, storeId);
  }

  // Financial reports are management-level
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('sales-summary')
  salesSummary(
    @CurrentUser() u: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeId') storeId?: string,
  ) {
    return this.reports.salesSummary(u.businessId, { from, to, storeId });
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('analytics')
  analytics(
    @CurrentUser() u: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeId') storeId?: string,
  ) {
    return this.reports.analytics(u.businessId, { from, to, storeId });
  }
}
