import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { SalesModel } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';
import { UserRole } from '@prisma/client';
import { BusinessService } from './business.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

export class UpdateBusinessDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  // NOTE: `type` (the vertical) is deliberately NOT editable here. It is locked
  // after signup and can only be changed by a platform super-admin.

  @ApiPropertyOptional({ enum: SalesModel })
  @IsOptional()
  @IsEnum(SalesModel)
  salesModel?: SalesModel;

  @ApiPropertyOptional({ description: '3-letter currency code' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  taxId?: string;

  @ApiPropertyOptional({ description: 'Prices include tax' })
  @IsOptional()
  @IsBoolean()
  taxInclusive?: boolean;
}

@ApiTags('business')
@ApiBearerAuth()
@Controller('business')
export class BusinessController {
  constructor(private readonly business: BusinessService) {}

  /** The current tenant's business profile. */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get()
  get(@CurrentUser() u: AuthUser) {
    return this.business.get(u.businessId);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Patch()
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateBusinessDto) {
    return this.business.update(u.businessId, dto);
  }

  /** Owner-only: full export of the business's data as a JSON snapshot. */
  @Roles(UserRole.OWNER)
  @Get('export')
  exportData(@CurrentUser() u: AuthUser) {
    return this.business.exportData(u.businessId);
  }
}
