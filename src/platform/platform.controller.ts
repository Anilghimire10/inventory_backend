import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { once } from 'events';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlatformService } from './platform.service';
import { AdminOnly, PlatformAuthGuard, SupportMayWrite } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor } from './platform-audit.service';
import {
  CreateBusinessDto,
  CreateBusinessNoteDto,
  DeleteBusinessDto,
  QueryBusinessesDto,
  DateRangeQueryDto,
  QueryOnboardingDto,
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
  businessCustomers(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query() q: PaginationDto,
  ) {
    return this.platform.businessCustomers(actor, id, q);
  }

  @Get('businesses/:id/sales')
  businessSales(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query() q: PaginationDto,
  ) {
    return this.platform.businessSales(actor, id, q);
  }

  @Get('businesses/:id/sales/:saleId')
  businessSale(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Param('saleId') saleId: string,
  ) {
    return this.platform.businessSale(actor, id, saleId);
  }

  @Get('businesses/:id/activity')
  businessActivity(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query() q: PaginationDto,
  ) {
    return this.platform.businessActivity(actor, id, q);
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

  /** Setup progress per shop, and the ones stuck before their first sale. */
  @Get('onboarding')
  onboarding(@Query() q: QueryOnboardingDto) {
    return this.platform.onboarding(q);
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

  // ---- More read-only tabs (each view is logged) ----

  @Get('businesses/:id/products')
  businessProducts(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query() q: PaginationDto,
  ) {
    return this.platform.businessProducts(actor, id, q);
  }

  @Get('businesses/:id/purchases')
  businessPurchases(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query() q: PaginationDto,
  ) {
    return this.platform.businessPurchases(actor, id, q);
  }

  @Get('businesses/:id/shifts')
  businessShifts(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query() q: PaginationDto,
  ) {
    return this.platform.businessShifts(actor, id, q);
  }

  // ---- Internal notes ----

  @Get('businesses/:id/notes')
  listNotes(@Param('id') id: string) {
    return this.platform.listNotes(id);
  }

  @SupportMayWrite()
  @Post('businesses/:id/notes')
  addNote(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: CreateBusinessNoteDto,
  ) {
    return this.platform.addNote(actor, id, dto);
  }

  @Delete('businesses/:id/notes/:noteId')
  deleteNote(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
  ) {
    return this.platform.deleteNote(actor, id, noteId);
  }

  /** A 30-minute, read-only session in the shop app as the owner. Logged. */
  @SupportMayWrite()
  @Post('businesses/:id/impersonate')
  impersonate(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.platform.impersonate(actor, id);
  }

  // ---- Export and deletion ----

  /**
   * The business's data as NDJSON, streamed page by page like the owner's own
   * export (BusinessController.exportData), honouring backpressure.
   */
  @AdminOnly()
  @Get('businesses/:id/export')
  async exportBusiness(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { name, chunks } = await this.platform.exportBusiness(actor, id);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-export-${stamp}.ndjson"`);
    for await (const chunk of chunks) {
      if (!res.write(chunk)) await once(res, 'drain');
    }
    res.end();
  }

  /** Permanently delete a business. `confirmName` must match its name. */
  @Delete('businesses/:id')
  deleteBusiness(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: DeleteBusinessDto,
  ) {
    return this.platform.deleteBusiness(actor, id, dto);
  }

  /** Global activity feed across all businesses. */
  @Get('activity')
  activity(@CurrentActor() actor: Actor, @Query() q: DateRangeQueryDto) {
    return this.platform.activityFeed(actor, q);
  }

  /** All subscription payments, newest first; ?from=&to= by when recorded. */
  @Get('payments')
  allPayments(@Query() q: DateRangeQueryDto) {
    return this.platform.allPayments(q);
  }
}
