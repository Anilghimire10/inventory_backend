import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAuthGuard, SupportMayWrite } from '../platform/platform-auth.guard';
import { CurrentActor } from '../platform/current-admin.decorator';
import { Actor } from '../platform/platform-audit.service';
import { SupportService } from './support.service';
import { QueryTicketsDto, SetTicketStatusDto, SupportMessageDto } from './dto/support.dto';

/**
 * The admin panel's Support page. Answering tickets is what SUPPORT accounts
 * are for, so both writes are open to them.
 */
// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin/support')
export class PlatformSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@Query() q: QueryTicketsDto) {
    return this.support.listForAdmin(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.support.getForAdmin(id);
  }

  @SupportMayWrite()
  @Post(':id/messages')
  reply(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() dto: SupportMessageDto) {
    return this.support.replyFromAdmin(actor, id, dto.body);
  }

  @SupportMayWrite()
  @Patch(':id')
  setStatus(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() dto: SetTicketStatusDto) {
    return this.support.setStatus(actor, id, dto.status);
  }
}
