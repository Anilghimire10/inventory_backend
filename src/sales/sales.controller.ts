import {
  BadRequestException,
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
import { IsEmail, IsOptional, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { HoldSaleDto } from './dto/hold-sale.dto';
import { ReturnQuoteQueryDto, ReturnSaleDto } from './dto/return-sale.dto';
import { QuerySaleDto } from './dto/query-sale.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { scopeToStore } from '../common/store-scope';

export class EmailReceiptDto {
  @ApiPropertyOptional({ description: 'Override recipient; defaults to the customer email' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
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

  /** What a return would hand back, before it is made. Writes nothing. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Get(':id/return-quote')
  returnQuote(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query() q: ReturnQuoteQueryDto,
  ) {
    const lines = q.parsed();
    if (!lines.length) throw new BadRequestException('Choose something to return');
    return this.sales.returnQuote(u, id, lines);
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

  /** Every bill the filter matches, one row each, for the accountant. Management only. */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('export')
  exportRows(@CurrentUser() u: AuthUser, @Query() q: QuerySaleDto) {
    q.storeId = scopeToStore(u, q.storeId);
    return this.sales.exportRows(u.businessId, q);
  }

  @Get()
  findAll(@CurrentUser() u: AuthUser, @Query() q: QuerySaleDto) {
    // Assigned in place rather than spread: QuerySaleDto carries prototype
    // getters (PaginationDto's `skip`) that a spread would silently drop.
    q.storeId = scopeToStore(u, q.storeId);
    // Revenue KPIs are management-only, the same rule reports.dashboard()
    // applies and the web mirrors with can.viewFinancials -- without this a
    // cashier reading /sales got the business's all-time revenue. Skipping
    // them also drops two aggregate queries from every list load for the
    // roles that cannot see the numbers.
    const includeFinancials =
      u.role === UserRole.OWNER || u.role === UserRole.MANAGER;
    return this.sales.findAll(u.businessId, q, includeFinancials);
  }

  /** Full sale detail incl. store/business info — used to render a receipt. */
  @Get(':id')
  findOne(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sales.findOne(u.businessId, id);
  }
}
