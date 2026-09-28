import { Body, Controller, Get, Headers, Ip, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PlatformAuthService } from './platform-auth.service';
import { AllowWithoutTwoFactor, PlatformAuthGuard, SupportMayWrite } from './platform-auth.guard';
import { CurrentActor, CurrentAdmin } from './current-admin.decorator';
import { PlatformPrincipal } from './strategies/platform-jwt.strategy';
import { Actor } from './platform-audit.service';
import {
  ChangePasswordDto,
  DisableTwoFactorDto,
  PlatformLoginDto,
  TwoFactorCodeDto,
} from './dto/platform.dto';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('admin-auth')
@Controller('admin/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  // @Public() bypasses the global tenant JwtAuthGuard.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Post('login')
  login(@Body() dto: PlatformLoginDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    return this.auth.login(dto.email, dto.password, ip ?? null, dto.code, userAgent ?? null);
  }

  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @AllowWithoutTwoFactor()
  @Get('me')
  async me(@CurrentAdmin() admin: PlatformPrincipal) {
    // Same shape as login's `admin`, so the panel's AdminInfo is the same
    // whether it came from signing in or from a page reload. Returning the
    // principal as-is sent `adminId`, and `admin.id` was undefined after
    // every refresh.
    const twoFactor = await this.auth.twoFactorStatus(admin.adminId);
    return {
      id: admin.adminId,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      twoFactorEnabled: twoFactor.enabled,
      // The platform requires it and this admin hasn't: the panel sends them
      // to set it up, and every other endpoint refuses until they do.
      twoFactorRequired: admin.twoFactorRequired,
    };
  }

  // ---- Two-factor ----

  /** Start enrolment: returns the secret and the otpauth:// URL to scan. */
  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @SupportMayWrite()
  @AllowWithoutTwoFactor()
  @Post('2fa/setup')
  setupTwoFactor(@CurrentActor() actor: Actor) {
    return this.auth.setupTwoFactor(actor);
  }

  /** Confirm enrolment with a code from the app; two-factor is on from here. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @SupportMayWrite()
  @AllowWithoutTwoFactor()
  @Post('2fa/enable')
  enableTwoFactor(@CurrentActor() actor: Actor, @Body() dto: TwoFactorCodeDto) {
    return this.auth.enableTwoFactor(actor, dto.code);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @SupportMayWrite()
  @Post('2fa/disable')
  disableTwoFactor(@CurrentActor() actor: Actor, @Body() dto: DisableTwoFactorDto) {
    return this.auth.disableTwoFactor(actor, dto);
  }

  /** Returns a new accessToken: tokens issued before the change stop working. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @SupportMayWrite()
  @AllowWithoutTwoFactor()
  @Post('change-password')
  changePassword(@CurrentActor() actor: Actor, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(actor, dto);
  }

  // ---- Sessions ----

  /** End this session. The panel calls it on sign-out. */
  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @SupportMayWrite()
  @AllowWithoutTwoFactor()
  @Post('logout')
  logout(@CurrentActor() actor: Actor) {
    return this.auth.logout(actor);
  }

  /** Where you're signed in: device, IP, when; this one flagged. */
  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @AllowWithoutTwoFactor()
  @Get('sessions')
  sessions(@CurrentActor() actor: Actor) {
    return this.auth.sessions(actor);
  }

  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @SupportMayWrite()
  @AllowWithoutTwoFactor()
  @Post('sessions/revoke-others')
  revokeOthers(@CurrentActor() actor: Actor) {
    return this.auth.revokeOtherSessions(actor);
  }

  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @SupportMayWrite()
  @AllowWithoutTwoFactor()
  @Post('sessions/:id/revoke')
  revokeSession(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.auth.revokeSession(actor, id);
  }
}
