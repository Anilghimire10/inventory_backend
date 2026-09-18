import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CreditService } from './credit.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { scopeToStore } from '../common/store-scope';

@ApiTags('credit')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER)
@Controller('credit')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Get('summary')
  summary(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    return this.credit.summary(u.businessId, scopeToStore(u, storeId));
  }

  @Get('receivables')
  receivables(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    return this.credit.receivables(u.businessId, scopeToStore(u, storeId));
  }

  @Get('payables')
  payables(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    return this.credit.payables(u.businessId, scopeToStore(u, storeId));
  }
}
