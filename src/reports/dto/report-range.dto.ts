import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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

  /**
   * A calendar day in the shop's own time zone (YYYY-MM-DD). Preferred over
   * `from`: "today" then means the shop's today, not the browser's -- they
   * differ for an owner checking in from abroad, or a device set wrong.
   */
  @ApiPropertyOptional({ example: '2026-06-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'fromDay must be YYYY-MM-DD' })
  fromDay?: string;

  /** Last calendar day included, in the shop's time zone. */
  @ApiPropertyOptional({ example: '2026-06-30' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDay must be YYYY-MM-DD' })
  toDay?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;
}
