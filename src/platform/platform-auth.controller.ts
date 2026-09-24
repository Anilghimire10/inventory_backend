import { Body, Controller, Get, Ip, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor, CurrentAdmin } from './current-admin.decorator';
import { PlatformPrincipal } from './strategies/platform-jwt.strategy';
import { Actor } from './platform-audit.service';
import { ChangePasswordDto, PlatformLoginDto } from './dto/platform.dto';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('admin-auth')
@Controller('admin/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  // @Public() bypasses the global tenant JwtAuthGuard.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Post('login')
  login(@Body() dto: PlatformLoginDto, @Ip() ip: string) {
    return this.auth.login(dto.email, dto.password, ip ?? null);
  }

  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentAdmin() admin: PlatformPrincipal) {
    // Same shape as login's `admin`, so the panel's AdminInfo is the same
    // whether it came from signing in or from a page reload. Returning the
    // principal as-is sent `adminId`, and `admin.id` was undefined after
    // every refresh.
    return { id: admin.adminId, email: admin.email, name: admin.name };
  }

  /** Returns a new accessToken: tokens issued before the change stop working. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @Post('change-password')
  changePassword(@CurrentActor() actor: Actor, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(actor, dto);
  }
}
