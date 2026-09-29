import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { AdjustStockDto, ImportStockDto, SetReorderLevelDto, WriteOffExpiredDto } from './dto/adjust-stock.dto';
import { StockTakeDto, TransferStockDto } from './dto/stock-ops.dto';
import {
  ExpiringDto,
  QueryMovementsDto,
  QuerySerialsDto,
  QueryStockDto,
} from './dto/query-inventory.dto';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { scopeToStore } from '../common/store-scope';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  stock(@CurrentUser() u: AuthUser, @Query() q: QueryStockDto) {
    // Assigned in place rather than spread: these query DTOs carry prototype
    // getters (PaginationDto's `skip`) that a spread would silently drop.
    q.storeId = scopeToStore(u, q.storeId);
    return this.inventory.listStock(u.businessId, q);
  }

  @Get('low-stock')
  lowStock(@CurrentUser() u: AuthUser, @Query('storeId') storeId?: string) {
    return this.inventory.lowStock(u.businessId, scopeToStore(u, storeId));
  }

  @Get('expiring')
  expiring(@CurrentUser() u: AuthUser, @Query() q: ExpiringDto) {
    q.storeId = scopeToStore(u, q.storeId);
    return this.inventory.expiringBatches(u.businessId, q);
  }

  /** Serial/IMEI register: search a serial, or list a product's/store's units. */
  @Get('serials')
  serials(@CurrentUser() u: AuthUser, @Query() q: QuerySerialsDto) {
    // Assigned in place rather than spread: these query DTOs carry prototype
    // getters (PaginationDto's `skip`) that a spread would silently drop.
    q.storeId = scopeToStore(u, q.storeId);
    return this.inventory.listSerials(u.businessId, q);
  }

  /** The in-stock serials of one product at one store: the pickers' checklist. */
  @Get('serials/in-stock')
  inStockSerials(
    @CurrentUser() u: AuthUser,
    @Query('storeId') storeId: string,
    @Query('productId') productId: string,
  ) {
    const store = scopeToStore(u, storeId);
    if (!store || !productId) throw new BadRequestException('storeId and productId are required');
    return this.inventory.inStockSerials(u.businessId, store, productId);
  }

  /** Where one serial is: scanning an IMEI at the till finds its product. */
  @Get('serials/lookup/:serial')
  lookupSerial(@CurrentUser() u: AuthUser, @Param('serial') serial: string) {
    return this.inventory.lookupSerial(u.businessId, serial);
  }

  @Get('movements')
  movements(@CurrentUser() u: AuthUser, @Query() q: QueryMovementsDto) {
    // Assigned in place rather than spread: these query DTOs carry prototype
    // getters (PaginationDto's `skip`) that a spread would silently drop.
    q.storeId = scopeToStore(u, q.storeId);
    return this.inventory.movements(u.businessId, q);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('adjust')
  adjust(@CurrentUser() u: AuthUser, @Body() dto: AdjustStockDto) {
    return this.inventory.adjust(u.businessId, u.userId, dto);
  }

  /** Opening stock from a spreadsheet; `dryRun` checks it without saving. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('import-stock')
  importStock(@CurrentUser() u: AuthUser, @Body() dto: ImportStockDto) {
    return this.inventory.importStock(u.businessId, u.userId, dto.items, {
      dryRun: dto.dryRun,
      storeId: scopeToStore(u, dto.storeId),
    });
  }

  /** Take expired stock off the shelf: an EXPIRED adjustment, batch emptied. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('expiring/write-off')
  writeOffExpired(@CurrentUser() u: AuthUser, @Body() dto: WriteOffExpiredDto) {
    return this.inventory.writeOffExpired(u.businessId, u.userId, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('reorder-level')
  setReorderLevel(@CurrentUser() u: AuthUser, @Body() dto: SetReorderLevelDto) {
    return this.inventory.setReorderLevel(u.businessId, dto);
  }

  /** Move stock between two stores (one reference links both legs). */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('transfer')
  transfer(@CurrentUser() u: AuthUser, @Body() dto: TransferStockDto) {
    return this.inventory.transfer(u.businessId, u.userId, dto);
  }

  /** Current stock for every active product, for a printable count sheet. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Get('count-sheet')
  countSheet(@CurrentUser() u: AuthUser, @Query('storeId') storeId: string) {
    return this.inventory.countSheet(u.businessId, storeId);
  }

  /** Post a physical count; `preview: true` returns the variances only. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('stock-take')
  stockTake(@CurrentUser() u: AuthUser, @Body() dto: StockTakeDto) {
    return this.inventory.stockTake(u.businessId, u.userId, dto);
  }
}
