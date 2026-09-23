import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ProductImageStorage } from './product-image.storage';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, ProductImageStorage],
  exports: [ProductsService],
})
export class ProductsModule {}
