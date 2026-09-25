import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PlatformAuthGuard } from './platform-auth.guard';
import { PlatformInsightsService } from './platform-insights.service';
import { QueryEmailLogDto } from './dto/platform.dto';

// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin')
export class PlatformInsightsController {
  constructor(private readonly insights: PlatformInsightsService) {}

  @Get('growth')
  growth() {
    return this.insights.growth();
  }

  @Get('system')
  system() {
    return this.insights.systemStatus();
  }

  @Get('email-log')
  emailLog(@Query() q: QueryEmailLogDto) {
    return this.insights.emailLog(q);
  }
}
