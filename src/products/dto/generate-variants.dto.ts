import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class VariantOptionDto {
  @ApiProperty({ example: 'Colour' })
  @IsString()
  @MaxLength(100)
  @MinLength(1)
  name: string;

  @ApiProperty({ example: ['Red', 'Blue'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  values: string[];
}

export class GenerateVariantsDto {
  @ApiProperty({
    type: [VariantOptionDto],
    description: 'One entry per axis; every combination becomes a variant',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => VariantOptionDto)
  options: VariantOptionDto[];

  @ApiPropertyOptional({ description: 'Overrides the parent price on every variant' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  sellingPrice?: number;

  @ApiPropertyOptional({ description: 'Overrides the parent cost on every variant' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPrice?: number;
}
