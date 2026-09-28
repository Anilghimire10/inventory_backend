import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlatformAdminsService } from './platform-admins.service';
import { PlatformAuditService, Actor } from './platform-audit.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { CreateAdminDto, QueryAuditLogDto, UpdateAdminDto } from './dto/platform.dto';
import { Public } from '../common/decorators/public.decorator';

/** Admin accounts and the admin-side audit log. */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin')
export class PlatformAdminsController {
  constructor(
    private readonly admins: PlatformAdminsService,
    private readonly audit: PlatformAuditService,
  ) {}

  @Get('admins')
  list() {
    return this.admins.list();
  }

  @Post('admins')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateAdminDto) {
    return this.admins.create(actor, dto);
  }

  @Patch('admins/:id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: UpdateAdminDto,
  ) {
    return this.admins.update(actor, id, dto);
  }

  /**
   * Sign another admin out of every session now -- a lost laptop, someone
   * leaving. Full admins only (support can't write here at all).
   */
  @Post('admins/:id/sign-out')
  signOut(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.admins.signOutEverywhere(actor, id);
  }

  /** What admins did. `?search=` matches the action, e.g. "suspend". */
  @Get('audit-log')
  auditLog(@Query() q: QueryAuditLogDto) {
    return this.audit.list(q);
  }
}
