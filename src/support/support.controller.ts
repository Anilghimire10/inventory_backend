import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { SupportService } from './support.service';
import { CreateTicketDto, QueryTicketsDto, SupportMessageDto } from './dto/support.dto';

/** The shop app's Help & support page. Every role can raise a ticket. */
@ApiTags('support')
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: QueryTicketsDto) {
    return this.support.listForShop(u, q);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.support.getForShop(u, id);
  }

  // Each new ticket can email the support inbox, so keep a runaway client
  // from filling it.
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTicketDto) {
    return this.support.create(u, dto);
  }

  @Post(':id/messages')
  reply(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SupportMessageDto) {
    return this.support.replyFromShop(u, id, dto.body);
  }
}
