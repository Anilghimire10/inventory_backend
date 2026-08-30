import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ShiftsService } from './shifts.service';
import { CloseShiftDto, OpenShiftDto, QueryShiftDto } from './dto/shift.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

@ApiTags('shifts')
@ApiBearerAuth()
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  /** Open the drawer for the day with a starting float. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post('open')
  open(@CurrentUser() u: AuthUser, @Body() dto: OpenShiftDto) {
    return this.shifts.open(u, dto);
  }

  /** The caller's open shift with running totals, or null. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Get('current')
  current(@CurrentUser() u: AuthUser) {
    return this.shifts.current(u);
  }

  /** Shift history — owners and managers only. */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get()
  findAll(@CurrentUser() u: AuthUser, @Query() q: QueryShiftDto) {
    return this.shifts.findAll(u.businessId, q);
  }

  /** X report while open, Z report once closed — same numbers either way. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Get(':id/report')
  report(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.shifts.report(u.businessId, id);
  }

  /** Close with the counted cash; stores expected, counted and variance. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post(':id/close')
  close(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: CloseShiftDto,
  ) {
    return this.shifts.close(u, id, dto);
  }
}
