import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { AuditService } from './audit.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { PaginationDto } from '../common/dto/pagination.dto';

/**
 * The log's filters. They used to be read with separate @Query('action') /
 * @Query('userId') params beside a PaginationDto -- but the global pipe
 * validates the whole query against that DTO and forbids unknown fields, so
 * any filter at all came back 400 and the page's filter box never worked.
 */
export class QueryAuditDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Part of the action name, e.g. "sale" or "product.delete"' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @ApiPropertyOptional({ description: 'Only what this staff member did' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;
}

@ApiTags('audit')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER)
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Owner-only activity log. */
  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: QueryAuditDto) {
    return this.audit.list(u.businessId, q, { action: q.action, userId: q.userId });
  }
}
