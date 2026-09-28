import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAuthGuard, SupportMayWrite } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor } from './platform-audit.service';
import { PlatformBillingService } from './platform-billing.service';
import { QueryRenewalsDto, RemindBusinessesDto } from './dto/platform.dto';

// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin')
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  /** A payment's receipt, for printing. */
  @Get('payments/:id/receipt')
  receipt(@Param('id') id: string) {
    return this.billing.receipt(id);
  }

  /** Email the receipt to the business's owners. Support may resend it. */
  @SupportMayWrite()
  @Post('payments/:id/email-receipt')
  emailReceipt(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.billing.emailReceipt(actor, id);
  }

  /** Subscriptions ending within `days`, and those already past their end. */
  @Get('renewals')
  renewals(@Query() q: QueryRenewalsDto) {
    return this.billing.renewals(q.days);
  }

  /** Send the renewal reminder to several businesses at once. Admin only. */
  @Post('renewals/remind')
  remind(@CurrentActor() actor: Actor, @Body() dto: RemindBusinessesDto) {
    return this.billing.remind(actor, dto.businessIds);
  }
}
