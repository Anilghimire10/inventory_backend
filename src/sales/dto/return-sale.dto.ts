import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { SETTLE_METHODS } from '../../payments/payments.service';
import { AdjustmentReason, PaymentMethod } from '@prisma/client';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ReturnItemDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  saleItemId: string;

  @ApiProperty({ example: 1, description: 'Quantity to return' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  quantity: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'false when the goods came back damaged or unfit to sell: they are ' +
      'booked back in and written off at once, so they never reach the shelf.',
  })
  @IsOptional()
  @IsBoolean()
  restock?: boolean;

  @ApiPropertyOptional({
    enum: [AdjustmentReason.DAMAGE, AdjustmentReason.EXPIRED],
    description:
      'Write the goods off as they come back, for this reason: damaged, or ' +
      'past their date. Implies restock: false; omitted with restock: false ' +
      'means damaged.',
  })
  @IsOptional()
  @IsIn([AdjustmentReason.DAMAGE, AdjustmentReason.EXPIRED])
  writeOffReason?: 'DAMAGE' | 'EXPIRED';

  @ApiPropertyOptional({
    type: [String],
    description:
      'Which serialised units came back. Defaults to the oldest units sold on this sale.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  serials?: string[];
}

export class ReturnSaleDto {
  @ApiPropertyOptional({
    description:
      'Which open till the refund is paid from. Only needed when more than ' +
      'one is open at the store and an owner or manager has picked one; ' +
      'otherwise the server resolves it, the same way a sale does.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  shiftId?: string;

  @ApiPropertyOptional({ description: 'Why the goods came back, e.g. "wrong size"' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({
    enum: SETTLE_METHODS,
    description:
      'The tender the refund is handed back on. Defaults to the one the sale ' +
      'was paid with; cash only counts against the drawer when it is cash.',
  })
  @IsOptional()
  @IsIn(SETTLE_METHODS)
  refundMethod?: PaymentMethod;

  @ApiProperty({ type: [ReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
}

/**
 * The lines of a return preview, compactly in the query string:
 * `lines=<saleItemId>:<quantity>,<saleItemId>:<quantity>`. A GET, so a
 * preview is never mistaken for a return in the activity log.
 */
export class ReturnQuoteQueryDto {
  @ApiProperty({ example: 'clx1a2b3c:2,clx4d5e6f:1' })
  @IsString()
  @MaxLength(4000)
  @Matches(/^[A-Za-z0-9_-]{1,64}:\d{1,9}(\.\d{1,3})?(,[A-Za-z0-9_-]{1,64}:\d{1,9}(\.\d{1,3})?)*$/, {
    message: 'lines must look like itemId:quantity,itemId:quantity',
  })
  lines: string;

  /** The parsed lines. Zero quantities are dropped: they return nothing. */
  parsed(): { saleItemId: string; quantity: number }[] {
    return this.lines
      .split(',')
      .map((pair) => {
        const [saleItemId, qty] = pair.split(':');
        return { saleItemId, quantity: Number(qty) };
      })
      .filter((l) => l.quantity > 0);
  }
}
