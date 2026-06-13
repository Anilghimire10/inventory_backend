import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReturnItemDto {
  @ApiProperty()
  @IsString()
  saleItemId: string;

  @ApiProperty({ example: 1, description: 'Quantity to return' })
  @IsInt()
  @Min(1)
  quantity: number;
}

export class ReturnSaleDto {
  @ApiProperty({ type: [ReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
}
