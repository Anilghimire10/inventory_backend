import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class TransferItemDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  productId: string;

  @ApiProperty({ example: 10, description: 'May be fractional for weighed goods' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity: number;

  @ApiPropertyOptional({ type: [String], description: 'Serialised products: the units being moved. Omitted, the oldest on file go.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  serials?: string[];
}

/** Move stock from one store to another. Both legs share one reference. */
export class TransferStockDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  fromStoreId: string;

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  toStoreId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiProperty({ type: [TransferItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items: TransferItemDto[];
}

export class StockCountDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  productId: string;

  @ApiProperty({ example: 42, description: 'Physically counted quantity' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  counted: number;

  @ApiPropertyOptional({ type: [String], description: 'Serialised products: every unit found. Its length is the count.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  serials?: string[];
}

/** A physical stock take: one posted adjustment per counted variance. */
export class StockTakeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  storeId: string;

  @ApiPropertyOptional({
    description: 'Return the variance list without posting anything',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  preview?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiProperty({ type: [StockCountDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockCountDto)
  counts: StockCountDto[];
}
