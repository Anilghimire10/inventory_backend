import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsArray } from 'class-validator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { GenerateVariantsDto } from './dto/generate-variants.dto';
import {
  PRODUCT_PUBLIC_PREFIX,
  productImageMulterOptions,
  UploadedImage,
} from './upload.config';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';

export class ImportProductsDto {
  @ApiProperty({ type: [Object], description: 'Rows parsed from a CSV/Excel file' })
  @IsArray()
  items: Record<string, unknown>[];
}

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

  /** Upload a product image; returns the path to store as the product's imageUrl. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('upload-image')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image', productImageMulterOptions))
  uploadImage(@UploadedFile() file?: UploadedImage) {
    if (!file) throw new BadRequestException('No image uploaded');
    return { imageUrl: `${PRODUCT_PUBLIC_PREFIX}/${file.filename}` };
  }

  /** Bulk import products from parsed CSV rows (upsert by SKU). */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post('import')
  importProducts(@CurrentUser() u: AuthUser, @Body() dto: ImportProductsDto) {
    return this.products.bulkImport(u.businessId, dto.items);
  }

  /** Export every product as flat rows for CSV download. */
  @Get('export')
  exportProducts(@CurrentUser() u: AuthUser) {
    return this.products.exportAll(u.businessId);
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

  /** The variants of one style (size/colour rows under a parent product). */
  @Get(':id/variants')
  variants(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.products.listVariants(u.businessId, id);
  }

  /** Bulk-create variants: one product per combination of the given options. */
  @Roles(UserRole.OWNER, UserRole.MANAGER, UserRole.STOCK_KEEPER)
  @Post(':id/variants')
  generateVariants(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Body() dto: GenerateVariantsDto,
  ) {
    return this.products.generateVariants(u.businessId, id, dto);
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
