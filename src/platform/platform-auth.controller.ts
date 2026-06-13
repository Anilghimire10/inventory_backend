import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString } from 'class-validator';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentAdmin } from './current-admin.decorator';
import { PlatformPrincipal } from './strategies/platform-jwt.strategy';
import { Public } from '../common/decorators/public.decorator';

class PlatformLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

@ApiTags('admin-auth')
@Controller('admin/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  // @Public() bypasses the global tenant JwtAuthGuard.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Public()
  @Post('login')
  login(@Body() dto: PlatformLoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @UseGuards(PlatformAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentAdmin() admin: PlatformPrincipal) {
    return admin;
  }
}
