import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlatformUsersService } from './platform-users.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor } from './platform-audit.service';
import { UpdateTenantUserDto } from './dto/platform.dto';
import { Public } from '../common/decorators/public.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

/** Shop users across every business, for support. */
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin/users')
export class PlatformUsersController {
  constructor(private readonly users: PlatformUsersService) {}

  /** `?search=` matches email or name. */
  @Get()
  search(@Query() q: PaginationDto) {
    return this.users.search(q);
  }

  /** Rename, fix a mistyped email, or (de)activate. */
  @Patch(':id')
  update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body() dto: UpdateTenantUserDto,
  ) {
    return this.users.update(actor, id, dto);
  }

  @Post(':id/verify-email')
  verifyEmail(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.users.verifyEmail(actor, id);
  }

  @Post(':id/resend-verification')
  resendVerification(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.users.resendVerification(actor, id);
  }

  @Post(':id/send-password-reset')
  sendPasswordReset(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.users.sendPasswordReset(actor, id);
  }
}
