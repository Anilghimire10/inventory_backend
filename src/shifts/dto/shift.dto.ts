import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class OpenShiftDto {
  @ApiPropertyOptional({ description: "Defaults to the cashier's store" })
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiProperty({ description: 'Cash in the drawer at the start', example: 5000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingFloat: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class CloseShiftDto {
  @ApiProperty({ description: 'Cash physically counted at close', example: 18450 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  countedCash: number;

  @ApiPropertyOptional({ description: 'Explanation for a variance, etc.' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class QueryShiftDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
