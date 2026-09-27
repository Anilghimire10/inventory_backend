import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CashMovementReason, CashMovementType } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class OpenShiftDto {
  @ApiPropertyOptional({ description: "Defaults to the cashier's store" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @ApiProperty({ description: 'Cash in the drawer at the start', example: 5000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingFloat: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    description:
      'Owner/manager only: open a second shift at a store where a till is ' +
      'already open. Only right when this counter has its own cash drawer; ' +
      'otherwise join the open till.',
  })
  @IsOptional()
  @IsBoolean()
  separateDrawer?: boolean;
}

export class CloseShiftDto {
  @ApiProperty({ description: 'Cash physically counted at close', example: 18450 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  countedCash: number;

  @ApiPropertyOptional({
    description:
      'Of the counted cash, what stays in the drawer as the next shift\'s float',
    example: 2000,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cashLeft?: number;

  @ApiPropertyOptional({
    description:
      'Notes and coins counted, denomination -> how many. Must add up to countedCash.',
    example: { '1000': 10, '500': 12, '100': 24 },
  })
  @IsOptional()
  @IsObject()
  cashCount?: Record<string, number>;

  @ApiPropertyOptional({ description: 'Explanation for a variance, etc.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CashMovementDto {
  @ApiProperty({ enum: CashMovementType })
  @IsEnum(CashMovementType)
  type: CashMovementType;

  @ApiProperty({ enum: CashMovementReason })
  @IsEnum(CashMovementReason)
  reason: CashMovementReason;

  @ApiProperty({ example: 250 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount: number;

  @ApiPropertyOptional({ description: 'Required when the reason is OTHER' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class QueryShiftDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
