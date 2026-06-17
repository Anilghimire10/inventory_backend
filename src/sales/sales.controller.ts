import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional } from 'class-validator';
import { UserRole } from '@prisma/client';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ReturnSaleDto } from './dto/return-sale.dto';
import { QuerySaleDto } from './dto/query-sale.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

export class EmailReceiptDto {
  @ApiPropertyOptional({ description: 'Override recipient; defaults to the customer email' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

@ApiTags('sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** Email the receipt for a sale to the customer. */
  @Throttle({ default: { limit: 8, ttl: 60_000 } }) // curb outbound-mail abuse
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post(':id/email-receipt')
  emailReceipt(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: EmailReceiptDto,
  ) {
    return this.sales.emailReceipt(u.businessId, id, dto.email);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateSaleDto) {
    return this.sales.create(u, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post(':id/return')
  returnItems(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReturnSaleDto,
  ) {
    return this.sales.returnItems(u, id, dto);
  }

  @Get()
  findAll(@CurrentUser() u: AuthUser, @Query() q: QuerySaleDto) {
    return this.sales.findAll(u.businessId, q);
  }

  /** Full sale detail incl. store/business info — used to render a receipt. */
  @Get(':id')
  findOne(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sales.findOne(u.businessId, id);
  }
}
