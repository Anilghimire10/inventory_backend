import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaymentMethod } from '@prisma/client';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SETTLE_METHODS } from '../../payments/payments.service';

export class PurchaseItemDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  productId: string;

  @ApiProperty({ example: 100, description: 'May be fractional for weighed goods' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity: number;

  @ApiProperty({ example: 0.5 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPrice: number;

  @ApiPropertyOptional({
    example: 13,
    description: 'VAT % the supplier charged on this line, on top of costPrice (input VAT). Default 0.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRate?: number;

  @ApiPropertyOptional({ description: 'Batch/lot number (expiry tracking)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
  @MaxLength(100, { each: true })
  serials?: string[];
}

export class CreatePurchaseDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  storeId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
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
      'Amount paid to the supplier now. Defaults to the full total, VAT included. Pass 0 (or a partial amount) to buy on credit.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amountPaid?: number;

  @ApiPropertyOptional({ enum: SETTLE_METHODS, default: PaymentMethod.CASH, description: 'How the amount paid now was paid' })
  @IsOptional()
  @IsIn(SETTLE_METHODS)
  paymentMethod?: PaymentMethod;

  @ApiProperty({ type: [PurchaseItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];
}
