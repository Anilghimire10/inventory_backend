import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { SerialStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class QueryStockDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storeId?: string;
}

export class QueryMovementsDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;
}

export class ExpiringDto {
  @ApiPropertyOptional({ default: 30, description: 'Days ahead to look' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  days = 30;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storeId?: string;
}

/** Serial/IMEI lookup: "where is this unit?" and "what does this store hold?" */
export class QuerySerialsDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  storeId?: string;

  @ApiPropertyOptional({ enum: SerialStatus })
  @IsOptional()
  @IsEnum(SerialStatus)
  status?: SerialStatus;
}
