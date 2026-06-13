import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

class SuspendDto {
  @IsBoolean()
  isSuspended: boolean;
}

// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('stats')
  stats() {
    return this.platform.stats();
  }

  @Get('businesses')
  listBusinesses(@Query() q: PaginationDto) {
    return this.platform.listBusinesses(q);
  }

  @Get('businesses/:id')
  getBusiness(@Param('id') id: string) {
    return this.platform.getBusiness(id);
  }

  @Patch('businesses/:id/suspend')
  suspend(@Param('id') id: string, @Body() dto: SuspendDto) {
    return this.platform.setSuspended(id, dto.isSuspended);
  }
}
