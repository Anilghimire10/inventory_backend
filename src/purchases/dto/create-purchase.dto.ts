import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PurchaseItemDto {
  @ApiProperty()
  @IsString()
  productId: string;

  @ApiProperty({ example: 100, description: 'May be fractional for weighed goods' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity: number;

  @ApiProperty({ example: 0.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPrice: number;

  @ApiPropertyOptional({ description: 'Batch/lot number (expiry tracking)' })
  @IsOptional()
  @IsString()
  batchNumber?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Serial/IMEI numbers, one per unit. Required for serialised products, and only when the purchase is received.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serials?: string[];
}

export class CreatePurchaseDto {
  @ApiProperty()
  @IsString()
  storeId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Receive immediately (adds stock). false = save as draft.',
  })
  @IsOptional()
  @IsBoolean()
  receiveNow?: boolean;

  @ApiPropertyOptional({
    description:
      'Amount paid to the supplier now. Defaults to the full total (paid in cash). Pass 0 (or a partial amount) to buy on credit.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountPaid?: number;

  @ApiProperty({ type: [PurchaseItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];
}
