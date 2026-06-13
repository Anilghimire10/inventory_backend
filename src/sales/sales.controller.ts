import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SalesService } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ReturnSaleDto } from './dto/return-sale.dto';
import { QuerySaleDto } from './dto/query-sale.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

@ApiTags('sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  // Cashiers and up can ring up sales
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
