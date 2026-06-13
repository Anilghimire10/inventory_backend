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
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('purchases')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreatePurchaseDto) {
    return this.purchases.create(u.businessId, dto);
  }

  @Post(':id/receive')
  receive(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.purchases.receive(u.businessId, id);
  }

  @Get()
  findAll(@CurrentUser() u: AuthUser, @Query() q: PaginationDto) {
    return this.purchases.findAll(u.businessId, q);
  }

  @Get(':id')
  findOne(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.purchases.findOne(u.businessId, id);
  }
}
