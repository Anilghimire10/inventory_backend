import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdjustmentReason } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  NotEquals,
  ValidateIf,
} from 'class-validator';

/** Opening stock rows from a spreadsheet. */
export class ImportStockDto {
  @ApiProperty({ type: [Object], description: 'Rows parsed from a CSV file' })
  @IsArray()
  items: Record<string, unknown>[];

  @ApiPropertyOptional({ description: 'The branch for rows that name none' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @ApiPropertyOptional({ description: 'Check the file and say what would happen, without saving anything' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

/** Write off expired stock: one batch, or (no batchId) a product's own expiry. */
export class WriteOffExpiredDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  storeId: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  productId: string;

  @ApiPropertyOptional({ description: 'The expired batch; omit for a product-level expiry date' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batchId?: string;
}

/**
 * Mark stock nearing its date down to sell it in time: one batch, or (no
 * batchId) a product's own dated stock at a store. `price: null` ends it.
 */
export class ClearanceDto extends WriteOffExpiredDto {
  @ApiProperty({ nullable: true, description: 'Clearance price per unit; null to end the markdown', example: 80 })
  @ValidateIf((o: ClearanceDto) => o.price !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number | null;
}

export class AdjustStockDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  storeId: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  productId: string;

  @ApiProperty({
    description: 'Signed change: +10 to add, -3 to remove',
    example: -3,
  })
  @IsNumber({ maxDecimalPlaces: 3 })
  @NotEquals(0)
  delta: number;

  @ApiProperty({ enum: AdjustmentReason })
  @IsEnum(AdjustmentReason)
  reason: AdjustmentReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Serialised products: one serial per unit -- the units added, or the in-stock units removed',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  serials?: string[];

  @ApiPropertyOptional({ description: 'Batch-tracked products, stock added: the batch it goes into' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  batchNumber?: string;

  @ApiPropertyOptional({ description: 'Batch-tracked products, stock added: its expiry date', example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}

export class SetReorderLevelDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  storeId: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  productId: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  reorderLevel: number;
}
