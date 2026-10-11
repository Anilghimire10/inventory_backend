import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ShiftsService } from './shifts.service';
import {
  CashMovementDto,
  CloseShiftDto,
  OpenShiftDto,
  QueryShiftDto,
} from './dto/shift.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { scopeToStore } from '../common/store-scope';

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

  /**
   * The till the caller is working on, with running totals, or null.
   *
   * For an owner or manager with no till of their own, that is the one open
   * at the store -- they join the cashier's drawer rather than opening a
   * second one for the same physical till. `shiftId` names which, for the
   * case where more than one is open and the client has asked.
   */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Get('current')
  current(
    @CurrentUser() u: AuthUser,
    @Query('storeId') storeId?: string,
    @Query('shiftId') shiftId?: string,
  ) {
    return this.shifts.current(u, scopeToStore(u, storeId), shiftId);
  }

  /**
   * Every till currently open at a store, for the "which drawer are you on?"
   * picker. Management only -- they are the only ones who may join one.
   */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get('open')
  openAtStore(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    const scoped = scopeToStore(u, storeId);
    if (!scoped) throw new BadRequestException('storeId is required');
    return this.shifts.openAtStore(u, scoped);
  }

  /**
   * What the last shift closed on this counter left in its drawer, offered
   * as the opening float. Null when it didn't say, or nothing has closed yet.
   * A cashier's counter is their own whatever is asked for.
   */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Get('float')
  suggestedFloat(
    @CurrentUser() u: AuthUser,
    @Query('storeId') storeId?: string,
    @Query('counterId') counterId?: string,
  ) {
    const scoped = scopeToStore(u, storeId);
    if (!scoped) throw new BadRequestException('storeId is required');
    return this.shifts.suggestedFloat(u, scoped, counterId);
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
    return this.shifts.report(u.businessId, id, u);
  }

  /** Pay in or pay out: cash into or out of an open drawer, with a reason. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.CASHIER)
  @Post(':id/movements')
  addMovement(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: CashMovementDto,
  ) {
    return this.shifts.addMovement(u, id, dto);
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
