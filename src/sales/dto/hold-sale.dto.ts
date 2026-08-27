import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsNumber,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { SaleItemDto } from './create-sale.dto';

/** Parks a cart server-side without touching stock or the receipt sequence. */
export class HoldSaleDto {
  @ApiPropertyOptional({ description: "Defaults to the cashier's store" })
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Bill-level discount amount', default: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discount?: number;

  @ApiPropertyOptional({ description: 'Pharmacy: prescription reference' })
  @IsOptional()
  @IsString()
  prescriptionRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];
}
