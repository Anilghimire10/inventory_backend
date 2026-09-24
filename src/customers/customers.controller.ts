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
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  PartialType,
} from '@nestjs/swagger';
import {
  IsEmail,
  IsNumber,
  IsOptional,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaymentMethod, UserRole } from '@prisma/client';
import { CustomersService } from './customers.service';
import { ShiftsService } from '../shifts/shifts.service';
import { PaymentsService, SETTLE_METHODS } from '../payments/payments.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { scopeToStore } from '../common/store-scope';
import { QueryCustomerDto } from './dto/query-customer.dto';

export class CreateCustomerDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

export class PayCreditDto {
  @ApiProperty({ description: 'Amount the customer is paying toward their dues' })
  @IsNumber({ maxDecimalPlaces: 2 })
  amount: number;

  @ApiPropertyOptional({
    enum: SETTLE_METHODS,
    default: PaymentMethod.CASH,
    description:
      'How they paid. Cash counts towards the till drawer at shift close; ' +
      'card and QR move the balance without touching it.',
  })
  @IsOptional()
  @IsIn(SETTLE_METHODS)
  method?: PaymentMethod;

  @ApiPropertyOptional({ description: 'Store the payment was taken at' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @ApiPropertyOptional({ description: 'Free-text reference, e.g. a receipt number' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    description:
      'The till the money went into, when an owner or manager has none of ' +
      'their own and more than one is open at the store. Checked with the ' +
      'same rule the POS uses to join a till.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  shiftId?: string;
}

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly shifts: ShiftsService,
    private readonly payments: PaymentsService,
  ) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(u.businessId, dto);
  }

  @Get()
  findAll(@CurrentUser() u: AuthUser, @Query() q: QueryCustomerDto) {
    // Assigned in place rather than spread: PaginationDto's `skip` is a
    // prototype getter that a spread would drop.
    q.storeId = scopeToStore(u, q.storeId);
    return this.customers.findAll(u.businessId, q);
  }

  @Get(':id')
  findOne(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.customers.findOne(u.businessId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(u.businessId, id, dto);
  }

  /**
   * The customer's account reconstructed from events: what went on the khata
   * (credit sales) and what they handed over (Payment rows), with the closing
   * figure computed from those rather than read off `creditBalance`. Both are
   * returned so they can be compared -- see `reconciles`.
   */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Get(':id/statement')
  statement(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.payments.customerStatement(u.businessId, id);
  }

  /** Record a payment against the customer's outstanding credit balance. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post(':id/pay-credit')
  async payCredit(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: PayCreditDto,
  ) {
    const storeId = scopeToStore(u, dto.storeId) ?? u.storeId ?? undefined;
    // Attach the payment to whichever till the taker is on, so cash collected
    // against a khata reaches that drawer's expected total. Resolved through
    // the same rule the POS uses, so an owner working on a cashier's till
    // books it to that cashier's drawer -- which is where the notes went.
    // With two tills open and none of their own, there is no safe guess;
    // the client asks and sends the choice as `shiftId`.
    const shiftId = storeId
      ? await this.shifts.resolveShiftId(u, storeId, dto.shiftId)
      : null;

    return this.customers.payCredit(u.businessId, id, dto.amount, {
      method: dto.method,
      userId: u.userId,
      storeId,
      shiftId,
      note: dto.note,
    });
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.customers.remove(u.businessId, id);
  }
}
