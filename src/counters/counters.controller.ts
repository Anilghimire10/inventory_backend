import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CountersService } from './counters.service';
import { CreateCounterDto, QueryCounterDto, UpdateCounterDto } from './dto/counter.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

/**
 * Owners and managers only: setting counters up, assigning cashiers to them
 * and choosing one at the till are theirs. A cashier's own counter comes back
 * with their shift.
 */
@ApiTags('counters')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER)
@Controller('counters')
export class CountersController {
  constructor(private readonly counters: CountersService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: QueryCounterDto) {
    return this.counters.list(u.businessId, q.storeId, q.all === 'true');
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateCounterDto) {
    return this.counters.create(u.businessId, dto);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateCounterDto) {
    return this.counters.update(u.businessId, id, dto);
  }
}
