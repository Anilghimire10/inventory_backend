import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { SettingsService } from './settings.service';

@ApiTags('status')
@Controller('status')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * What the shop app needs before anyone signs in: the maintenance banner,
   * whether the app is closed for maintenance, and whether the register form
   * is open. Public, and nothing else from the
   * settings is included.
   */
  @Public()
  @SkipThrottle()
  @Get()
  async status() {
    const s = await this.settings.get();
    return { maintenanceMessage: s.maintenanceMessage, maintenanceMode: s.maintenanceMode, signupOpen: s.signupOpen };
  }
}
