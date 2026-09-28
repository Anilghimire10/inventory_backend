import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor } from './platform-audit.service';
import { PlatformAnnouncementsService } from './platform-announcements.service';
import { SendAnnouncementDto } from './dto/platform.dto';

// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin/announcements')
export class PlatformAnnouncementsController {
  constructor(private readonly announcements: PlatformAnnouncementsService) {}

  @Get()
  history() {
    return this.announcements.history();
  }

  @Post()
  send(@CurrentActor() actor: Actor, @Body() dto: SendAnnouncementDto) {
    return this.announcements.send(actor, dto);
  }

  /** Stop a scheduled announcement before it goes out. */
  @Post(':id/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.announcements.cancel(actor, id);
  }
}
