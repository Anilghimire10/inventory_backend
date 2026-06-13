import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdjustmentReason } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  NotEquals,
} from 'class-validator';

export class AdjustStockDto {
  @ApiProperty()
  @IsString()
  storeId: string;

  @ApiProperty()
  @IsString()
  productId: string;

  @ApiProperty({
    description: 'Signed change: +10 to add, -3 to remove',
    example: -3,
  })
  @IsInt()
  @NotEquals(0)
  delta: number;

  @ApiProperty({ enum: AdjustmentReason })
  @IsEnum(AdjustmentReason)
  reason: AdjustmentReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class SetReorderLevelDto {
  @ApiProperty()
  @IsString()
  storeId: string;

  @ApiProperty()
  @IsString()
  productId: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  reorderLevel: number;
}
