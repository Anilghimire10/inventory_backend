import {
  Body,
  Controller,
  Delete,
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
import { HoldSaleDto } from './dto/hold-sale.dto';
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

  /** Park a cart server-side, without deducting stock or a receipt number. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post('hold')
  hold(@CurrentUser() u: AuthUser, @Body() dto: HoldSaleDto) {
    return this.sales.hold(u, dto);
  }

  /** Return a held sale's cart lines to the caller and remove the parked row. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post(':id/resume')
  resume(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sales.resumeHeld(u.businessId, id);
  }

  /** Discard a parked sale (held only) without resuming it. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Delete(':id')
  discard(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sales.discardHeld(u.businessId, id);
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
