import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateProductDto) {
    return this.products.create(u.businessId, dto);
  }

  @Get()
  findAll(@CurrentUser() u: AuthUser, @Query() q: QueryProductDto) {
    return this.products.findAll(u.businessId, q);
  }

  @Get('barcode/:barcode')
  findByBarcode(@CurrentUser() u: AuthUser, @Param('barcode') barcode: string) {
    return this.products.findByBarcode(u.businessId, barcode);
  }

  @Get(':id')
  findOne(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.products.findOne(u.businessId, id);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Patch(':id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(u.businessId, id, dto);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.products.remove(u.businessId, id);
  }
}
