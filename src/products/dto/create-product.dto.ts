import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { UNITS, normalizeUnit } from '../../common/units';

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Stores that carry this product. Omit to stock it at every store.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  storeIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'IDs of one or more categories this product belongs to',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  categoryIds?: string[];

  @ApiPropertyOptional({
    description: 'Image path returned by POST /products/upload-image',
  })
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Product expiry date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional({
    default: 'pcs',
    enum: UNITS,
    description:
      'Unit of sale. Discrete units (pcs, box, pkt, dozen, pair) may only be ' +
      'sold in whole numbers; measured ones (kg, g, l, ml, m, ft) accept ' +
      'fractions to 3 decimal places. Common spellings such as "Kg" or ' +
      '"litre" are accepted and stored canonical.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (normalizeUnit(value) ?? value) : value,
  )
  @IsIn(UNITS)
  unit?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPrice?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  sellingPrice?: number;

  @ApiPropertyOptional({ description: 'Id of an admin-defined tax (sets the rate)' })
  @IsOptional()
  @IsString()
  taxId?: string;

  @ApiPropertyOptional({
    default: 0,
    description: 'Tax percent (auto-set from taxId when provided)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxRate?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  reorderLevel?: number;

  @ApiPropertyOptional({
    default: true,
    description: 'Whether this product is subject to tax',
  })
  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  @ApiPropertyOptional({ description: 'Pharmacy: prescription required' })
  @IsOptional()
  @IsBoolean()
  isRxRequired?: boolean;

  @ApiPropertyOptional({ description: 'Track batches & expiry dates' })
  @IsOptional()
  @IsBoolean()
  trackBatches?: boolean;

  @ApiPropertyOptional({
    description:
      'Track every unit by serial/IMEI. Purchases and sales of this product must then carry one serial per unit.',
  })
  @IsOptional()
  @IsBoolean()
  trackSerials?: boolean;

  @ApiPropertyOptional({
    description:
      'Make this a variant of another product (usually created via POST /products/:id/variants)',
  })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ description: 'Variant label, e.g. "Red / XL"' })
  @IsOptional()
  @IsString()
  variantName?: string;

  @ApiPropertyOptional({
    description: 'Options behind the label, e.g. { "Colour": "Red", "Size": "XL" }',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}
