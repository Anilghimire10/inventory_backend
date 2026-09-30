import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor } from './platform-audit.service';
import { PlatformClaimsService } from './platform-claims.service';
import { ConfirmPaymentClaimDto, QueryPaymentClaimsDto, RejectPaymentClaimDto } from './dto/platform.dto';

/**
 * Admin panel → Payments to confirm. Support accounts can see the list;
 * confirming or rejecting is money, so it is left to full admins (no
 * @SupportMayWrite).
 */
// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin/payment-claims')
export class PlatformClaimsController {
  constructor(private readonly claims: PlatformClaimsService) {}

  @Get()
  list(@Query() q: QueryPaymentClaimsDto) {
    return this.claims.list(q);
  }

  @Post(':id/confirm')
  confirm(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() dto: ConfirmPaymentClaimDto) {
    return this.claims.confirm(actor, id, dto);
  }

  @Post(':id/reject')
  reject(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() dto: RejectPaymentClaimDto) {
    return this.claims.reject(actor, id, dto.reason);
  }
}
