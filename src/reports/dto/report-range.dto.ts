import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The range and branch a report covers.
 *
 * `from` / `to` used to arrive as raw strings and go straight into
 * `new Date(...)`, so a typo'd date became an Invalid Date inside a query and
 * came back as a 500. Validated here, it is a 400 that names the field.
 */
export class ReportRangeDto {
  @ApiPropertyOptional({ example: '2026-06-01T00:00:00+05:45' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-30T23:59:59+05:45' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;
}
