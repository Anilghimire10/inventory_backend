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
import { IsBoolean, IsDateString, IsOptional } from 'class-validator';
import { PlatformService } from './platform.service';
import { PlatformAuthGuard } from './platform-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';

class SuspendDto {
  @IsBoolean()
  isSuspended: boolean;
}

class SetSubscriptionDto {
  @IsBoolean()
  isSubscribed: boolean;

  @IsOptional()
  @IsDateString()
  subscribedTo?: string | null;
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

  @Get('businesses/:id/customers')
  businessCustomers(@Param('id') id: string, @Query() q: PaginationDto) {
    return this.platform.businessCustomers(id, q);
  }

  @Get('businesses/:id/sales')
  businessSales(@Param('id') id: string, @Query() q: PaginationDto) {
    return this.platform.businessSales(id, q);
  }

  @Get('businesses/:id/sales/:saleId')
  businessSale(@Param('id') id: string, @Param('saleId') saleId: string) {
    return this.platform.businessSale(id, saleId);
  }

  @Get('businesses/:id/activity')
  businessActivity(@Param('id') id: string, @Query() q: PaginationDto) {
    return this.platform.businessActivity(id, q);
  }

  @Patch('businesses/:id/suspend')
  suspend(@Param('id') id: string, @Body() dto: SuspendDto) {
    return this.platform.setSuspended(id, dto.isSuspended);
  }

  @Patch('businesses/:id/subscription')
  setSubscription(@Param('id') id: string, @Body() dto: SetSubscriptionDto) {
    return this.platform.setSubscription(id, dto.isSubscribed, dto.subscribedTo ?? null);
  }

  /** Global activity feed across all businesses. */
  @Get('activity')
  activity(@Query() q: PaginationDto) {
    return this.platform.activityFeed(q);
  }
}
