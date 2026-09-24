import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
