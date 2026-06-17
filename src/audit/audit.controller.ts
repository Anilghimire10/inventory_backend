import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuditService } from './audit.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('audit')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER)
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Owner-only activity log. */
  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query() q: PaginationDto,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
  ) {
    return this.audit.list(u.businessId, q, { action, userId });
  }
}
