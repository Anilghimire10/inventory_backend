import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CreditService } from './credit.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

@ApiTags('credit')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER)
@Controller('credit')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Get('summary')
  summary(@CurrentUser() u: AuthUser) {
    return this.credit.summary(u.businessId);
  }

  @Get('receivables')
  receivables(@CurrentUser() u: AuthUser) {
    return this.credit.receivables(u.businessId);
  }

  @Get('payables')
  payables(@CurrentUser() u: AuthUser) {
    return this.credit.payables(u.businessId);
  }
}
