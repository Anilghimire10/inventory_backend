import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCounterDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  storeId: string;

  @ApiProperty({ example: 'Counter 2' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;
}

export class UpdateCounterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ description: 'false to stop using it; its history stays' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class QueryCounterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @ApiPropertyOptional({ description: 'Include counters no longer in use' })
  @IsOptional()
  @IsString()
  all?: string;
}
