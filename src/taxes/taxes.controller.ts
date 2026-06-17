import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { TaxesService } from './taxes.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

export class CreateTaxDto {
  @ApiProperty({ example: 'VAT' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ example: 13, description: 'Percentage rate' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rate: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Use as the default tax for new products' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateTaxDto extends PartialType(CreateTaxDto) {}

@ApiTags('taxes')
@ApiBearerAuth()
@Controller('taxes')
export class TaxesController {
  constructor(private readonly taxes: TaxesService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.taxes.list(u.businessId);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTaxDto) {
    return this.taxes.create(u.businessId, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaxDto,
  ) {
    return this.taxes.update(u.businessId, id, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.taxes.remove(u.businessId, id);
  }
}
