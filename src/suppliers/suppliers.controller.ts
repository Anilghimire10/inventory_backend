import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiPropertyOptional,
  ApiTags,
  PartialType,
} from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { SuppliersService } from './suppliers.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { PaginationDto } from '../common/dto/pagination.dto';

export class CreateSupplierDto {
  @IsString()
  @MaxLength(200)
  @MinLength(1)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string;
}

export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

@ApiTags('suppliers')
@ApiBearerAuth()
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(u.businessId, dto);
  }

  @Get()
  findAll(@CurrentUser() u: AuthUser, @Query() q: PaginationDto) {
    return this.suppliers.findAll(u.businessId, q);
  }

  /** The supplier, with purchase totals, what is owed, and recent purchases. */
  @Get(':id')
  findOne(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.suppliers.details(u.businessId, id);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.suppliers.update(u.businessId, id, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.suppliers.remove(u.businessId, id);
  }
}
