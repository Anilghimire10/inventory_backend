import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { InventoryService } from './inventory.service';
import { AdjustStockDto, SetReorderLevelDto } from './dto/adjust-stock.dto';
import {
  ExpiringDto,
  QueryMovementsDto,
  QueryStockDto,
} from './dto/query-inventory.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  stock(@CurrentUser() u: AuthUser, @Query() q: QueryStockDto) {
    return this.inventory.listStock(u.businessId, q);
  }

  @Get('low-stock')
  lowStock(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    return this.inventory.lowStock(u.businessId, storeId);
  }

  @Get('expiring')
  expiring(@CurrentUser() u: AuthUser, @Query() q: ExpiringDto) {
    return this.inventory.expiringBatches(u.businessId, q);
  }

  @Get('movements')
  movements(@CurrentUser() u: AuthUser, @Query() q: QueryMovementsDto) {
    return this.inventory.movements(u.businessId, q);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('adjust')
  adjust(@CurrentUser() u: AuthUser, @Body() dto: AdjustStockDto) {
    return this.inventory.adjust(u.businessId, u.userId, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('reorder-level')
  setReorderLevel(@CurrentUser() u: AuthUser, @Body() dto: SetReorderLevelDto) {
    return this.inventory.setReorderLevel(u.businessId, dto);
  }
}
