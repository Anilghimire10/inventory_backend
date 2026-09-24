import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdjustmentReason } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  NotEquals,
} from 'class-validator';

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
