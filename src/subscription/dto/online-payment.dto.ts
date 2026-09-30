import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';
import type { GatewayId } from '../payment-gateways';

/** Pay online: which gateway, which plan, and where to come back to. */
export class StartOnlinePaymentDto {
  @ApiProperty({ enum: ['ESEWA', 'KHALTI', 'CONNECTIPS'] })
  @IsIn(['ESEWA', 'KHALTI', 'CONNECTIPS'])
  gateway: GatewayId;

  @ApiProperty({ example: 'business', description: 'The plan, by its id' })
  @IsString()
  @MaxLength(40)
  planId: string;

  @ApiProperty({ example: 1, description: 'How long: 1, 3 or 12 months. The price comes from the plan' })
  @IsIn([1, 3, 12])
  months: number;

  @ApiProperty({ example: 'https://app.example.com', description: "The shop app's origin, to return to" })
  @IsString()
  @MaxLength(200)
  returnOrigin: string;
}
