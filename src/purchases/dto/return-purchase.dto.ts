import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ReturnPurchaseItemDto {
  @ApiProperty({ description: 'Id of the purchase line being returned' })
  @IsString()
  purchaseItemId: string;

  @ApiProperty({ example: 5, description: 'Quantity going back to the supplier' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Which serialised units are going back. Defaults to the oldest units this purchase brought in.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serials?: string[];
}

/** Purchase return / debit note: goods going back to the supplier. */
export class ReturnPurchaseDto {
  @ApiPropertyOptional({ description: 'Reason — damaged, wrong item, etc.' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({ type: [ReturnPurchaseItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnPurchaseItemDto)
  items: ReturnPurchaseItemDto[];
}
