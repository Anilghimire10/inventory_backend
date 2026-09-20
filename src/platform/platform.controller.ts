import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor } from './platform-audit.service';
import {
  CreateBusinessDto,
  QueryBusinessesDto,
  RecordPaymentDto,
  SetSubscriptionDto,
  SuspendDto,
  UpdateBusinessDto,
} from './dto/platform.dto';
import { Public } from '../common/decorators/public.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('stats')
  stats() {
    return this.platform.stats();
  }

  /**
   * Filter with status, subscription (active | trial | expiring | expired |
   * inactive | no-expiry), type and days; order with sort. The renewals page
   * is `?subscription=expiring&days=7&sort=expiry`.
   */
  @Get('businesses')
  listBusinesses(@Query() q: QueryBusinessesDto) {
    return this.platform.listBusinesses(q);
  }

  /** Onboard a shop by hand: business + Main Store + verified owner. */
  @Post('businesses')
  createBusiness(@CurrentActor() actor: Actor, @Body() dto: CreateBusinessDto) {
    return this.platform.createBusiness(actor, dto);
  }

  @Get('businesses/:id')
  getBusiness(@Param('id') id: string) {
    return this.platform.getBusiness(id);
  }

  @Patch('businesses/:id')
  updateBusiness(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.platform.updateBusiness(actor, id, dto);
  }

  @Get('businesses/:id/customers')
  businessCustomers(@Param('id') id: string, @Query() q: PaginationDto) {
    return this.platform.businessCustomers(id, q);
  }

  @Get('businesses/:id/sales')
  businessSales(@Param('id') id: string, @Query() q: PaginationDto) {
    return this.platform.businessSales(id, q);
  }

  @Get('businesses/:id/sales/:saleId')
  businessSale(@Param('id') id: string, @Param('saleId') saleId: string) {
    return this.platform.businessSale(id, saleId);
  }

  @Get('businesses/:id/activity')
  businessActivity(@Param('id') id: string, @Query() q: PaginationDto) {
    return this.platform.businessActivity(id, q);
  }

  @Patch('businesses/:id/suspend')
  suspend(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: SuspendDto,
  ) {
    return this.platform.setSuspended(actor, id, dto);
  }

  @Patch('businesses/:id/subscription')
  setSubscription(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: SetSubscriptionDto,
  ) {
    return this.platform.setSubscription(actor, id, dto.isSubscribed, dto.subscribedTo ?? null);
  }

  @Get('businesses/:id/payments')
  listPayments(@Param('id') id: string, @Query() q: PaginationDto) {
    return this.platform.listPayments(id, q);
  }

  /** Record a subscription payment; extends the paid-until date. */
  @Post('businesses/:id/payments')
  recordPayment(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
  ) {
    return this.platform.recordPayment(actor, id, dto);
  }

  /** Email the owners and post a bell notification about the end date now. */
  @Post('businesses/:id/send-reminder')
  sendReminder(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.platform.sendReminder(actor, id);
  }

  /** Global activity feed across all businesses. */
  @Get('activity')
  activity(@Query() q: PaginationDto) {
    return this.platform.activityFeed(q);
  }
}
