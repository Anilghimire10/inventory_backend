import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ReceiveSerialsDto {
  @ApiProperty({ description: 'Id of the purchase line these units belong to' })
  @IsString()
  purchaseItemId: string;

  @ApiProperty({ type: [String], description: 'One serial/IMEI per unit' })
  @IsArray()
  @IsString({ each: true })
  serials: string[];
}

/**
 * Body for receiving a draft purchase. Serialised lines are scanned when the
 * goods physically arrive, which is why the numbers are supplied here rather
 * than when the order was raised.
 */
export class ReceivePurchaseDto {
  @ApiPropertyOptional({ type: [ReceiveSerialsDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveSerialsDto)
  items?: ReceiveSerialsDto[];
}
