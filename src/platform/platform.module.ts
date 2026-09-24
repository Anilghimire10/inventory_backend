import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { platformJwtSecret } from '../common/env.validation';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformUsersController } from './platform-users.controller';
import { PlatformUsersService } from './platform-users.service';
import { PlatformAdminsController } from './platform-admins.controller';
import { PlatformAdminsService } from './platform-admins.service';
import { PlatformAuditService } from './platform-audit.service';
import { SubscriptionRemindersService } from './subscription-reminders.service';
import { PlatformJwtStrategy } from './strategies/platform-jwt.strategy';

@Module({
  imports: [
    PassportModule,
    // AuthService issues the verification / reset codes the support tools send.
    AuthModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Its own key, not JWT_SECRET, so shop tokens can't verify here.
        secret: platformJwtSecret((k) => config.get<string>(k)),
        // Shorter than a shop user's session: an admin token opens every business.
        signOptions: { expiresIn: config.get<string>('PLATFORM_JWT_EXPIRES_IN') ?? '12h' },
      }),
    }),
  ],
  controllers: [
    PlatformAuthController,
    PlatformController,
    PlatformUsersController,
    PlatformAdminsController,
  ],
  providers: [
    PlatformAuthService,
    PlatformService,
    PlatformUsersService,
    PlatformAdminsService,
    PlatformAuditService,
    SubscriptionRemindersService,
    PlatformJwtStrategy,
  ],
})
export class PlatformModule {}
