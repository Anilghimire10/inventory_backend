import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';
import { UserRole } from '@prisma/client';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { PaginationDto } from '../common/dto/pagination.dto';

export class PayPurchaseDto {
  @ApiProperty({ description: 'Amount being paid to the supplier' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;
}

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

  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseDto,
  ) {
    return this.purchases.update(u.businessId, id, dto);
  }

  @Post(':id/receive')
  receive(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.purchases.receive(u.businessId, id);
  }

  /** Record a payment to the supplier against this purchase (credit settlement). */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Post(':id/pay')
  pay(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: PayPurchaseDto,
  ) {
    return this.purchases.recordPayment(u.businessId, id, dto.amount);
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
