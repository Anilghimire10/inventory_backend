import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ReportsService } from './reports.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { scopeToStore } from '../common/store-scope';
import { ReportRangeDto } from './dto/report-range.dto';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    // Financial figures (revenue, profit, inventory value) are shown to
    // management (owner/manager) only.
    const includeFinancials =
      u.role === UserRole.OWNER || u.role === UserRole.MANAGER;
    return this.reports.dashboard(
      u.businessId,
      scopeToStore(u, storeId),
      includeFinancials,
    );
  }

  // Financial reports & analytics are management-level.
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('sales-summary')
  async salesSummary(@CurrentUser() u: AuthUser, @Query() q: ReportRangeDto) {
    return this.reports.salesSummary(u.businessId, await this.reports.resolveRange(u.businessId, q));
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('tax')
  async taxReport(@CurrentUser() u: AuthUser, @Query() q: ReportRangeDto) {
    return this.reports.taxReport(u.businessId, await this.reports.resolveRange(u.businessId, q));
  }

  /**
   * Outstanding customer credit, aged into 0-30 / 30-60 / 60+ day buckets.
   * Management-only: it is a financial position, like the other reports here.
   */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('credit-ageing')
  creditAgeing(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    return this.reports.creditAgeing(u.businessId, {
      storeId: scopeToStore(u, storeId),
    });
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('analytics')
  async analytics(@CurrentUser() u: AuthUser, @Query() q: ReportRangeDto) {
    return this.reports.analytics(u.businessId, await this.reports.resolveRange(u.businessId, q));
  }
}
