import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod, UserRole } from '@prisma/client';
import { PurchasesService } from './purchases.service';
import { SETTLE_METHODS } from '../payments/payments.service';
import { CreatePurchaseDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { ReturnPurchaseDto } from './dto/return-purchase.dto';
import { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { PaginationDto } from '../common/dto/pagination.dto';

export class PayPurchaseDto {
  @ApiProperty({ description: 'Amount being paid to the supplier' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({ enum: SETTLE_METHODS, default: PaymentMethod.CASH })
  @IsOptional()
  @IsIn(SETTLE_METHODS)
  method?: PaymentMethod;

  @ApiPropertyOptional({ description: 'Free-text reference, e.g. a cheque number' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ReorderDraftDto {
  @ApiPropertyOptional({ description: 'Only this store' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @ApiPropertyOptional({ description: 'Only this supplier' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierId?: string;
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

  /** Receive a draft; serialised lines carry their scanned serials/IMEIs. */
  @Post(':id/receive')
  receive(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReceivePurchaseDto,
  ) {
    return this.purchases.receive(u.businessId, id, dto);
  }

  /** Send goods back to the supplier (debit note); shrinks stock and payable. */
  @Post(':id/return')
  returnItems(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReturnPurchaseDto,
  ) {
    return this.purchases.returnItems(u.businessId, u.userId, id, dto);
  }

  /** Record a payment to the supplier against this purchase (credit settlement). */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Post(':id/pay')
  pay(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: PayPurchaseDto,
  ) {
    return this.purchases.recordPayment(u.businessId, id, dto.amount, {
      method: dto.method,
      userId: u.userId,
      note: dto.note,
    });
  }

  /** Suggested reorder quantities, grouped into one draft order per supplier. */
  @Get('reorder-suggestions')
  reorderSuggestions(
    @CurrentUser() u: AuthUser,
    @Query('storeId') storeId?: string,
  ) {
    return this.purchases.reorderSuggestions(u.businessId, storeId);
  }

  /** Create the suggested orders as DRAFT purchases (nothing received/paid). */
  @Post('reorder-drafts')
  reorderDrafts(@CurrentUser() u: AuthUser, @Body() dto: ReorderDraftDto) {
    return this.purchases.createReorderDrafts(u.businessId, dto);
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
