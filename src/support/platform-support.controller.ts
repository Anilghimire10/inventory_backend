import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAuthGuard, SupportMayWrite } from '../platform/platform-auth.guard';
import { CurrentActor } from '../platform/current-admin.decorator';
import { Actor } from '../platform/platform-audit.service';
import { SupportService } from './support.service';
import {
  AdminQueryTicketsDto,
  AssignTicketDto,
  ReplyTemplateDto,
  SetTicketStatusDto,
  SupportMessageDto,
} from './dto/support.dto';

/**
 * The admin panel's Support page. Answering tickets is what SUPPORT accounts
 * are for, so every write here -- replies, status, assignment and saved
 * replies -- is open to them.
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
  list(@CurrentActor() actor: Actor, @Query() q: AdminQueryTicketsDto) {
    return this.support.listForAdmin(q, actor);
  }

  // Saved replies. Declared before ':id' so "templates" isn't taken for a
  // ticket id. Support staff manage their own canned answers.
  @Get('templates')
  templates() {
    return this.support.listTemplates();
  }

  @SupportMayWrite()
  @Post('templates')
  createTemplate(@CurrentActor() actor: Actor, @Body() dto: ReplyTemplateDto) {
    return this.support.createTemplate(actor, dto);
  }

  @SupportMayWrite()
  @Patch('templates/:tid')
  updateTemplate(@Param('tid') tid: string, @Body() dto: ReplyTemplateDto) {
    return this.support.updateTemplate(tid, dto);
  }

  @SupportMayWrite()
  @Delete('templates/:tid')
  deleteTemplate(@Param('tid') tid: string) {
    return this.support.deleteTemplate(tid);
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

  /** Hand the ticket to an admin, or unassign it (adminId: null). */
  @SupportMayWrite()
  @Patch(':id/assign')
  assign(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() dto: AssignTicketDto) {
    return this.support.assign(actor, id, dto.adminId);
  }

  @SupportMayWrite()
  @Patch(':id')
  setStatus(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() dto: SetTicketStatusDto) {
    return this.support.setStatus(actor, id, dto.status);
  }
}
