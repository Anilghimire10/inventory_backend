import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * A `?flag=true|false` query parameter as a boolean.
 *
 * Reads the raw value from `obj`, not `value`: the global ValidationPipe runs
 * with `enableImplicitConversion`, which has already turned the string into a
 * boolean by the time `value` arrives -- and `Boolean('false')` is `true`. So
 * `?activeOnly=false` meant active only, and a purchase line on a product
 * since deactivated could not be looked up.
 */
const QueryBoolean = () =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    return raw === true || raw === 'true';
  });

export class QueryProductDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Only products this store carries. Staff pinned to a store always get their own.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Only active products', default: true })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  activeOnly?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Return exactly these product IDs (e.g. a POS favorites grid)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? (value as string[]) : [value],
  )
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids?: string[];

  @ApiPropertyOptional({
    description: 'Only the variants of this product',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentId?: string;

  @ApiPropertyOptional({
    description: 'Hide variant rows, listing only standalone products and parents',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  excludeVariants?: boolean;

  @ApiPropertyOptional({
    description: 'Only products tracked by serial number (the serial register filter)',
  })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  trackSerials?: boolean;
}
