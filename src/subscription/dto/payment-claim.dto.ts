import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SubscriptionPaymentMethod } from '@prisma/client';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** "I've paid": what the shop paid, and what an admin needs to find it. */
export class CreatePaymentClaimDto {
  @ApiProperty({ example: 1500 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(10_000_000)
  amount: number;

  @ApiProperty({ enum: SubscriptionPaymentMethod })
  @IsEnum(SubscriptionPaymentMethod)
  method: SubscriptionPaymentMethod;

  @ApiPropertyOptional({ description: 'Transaction ID or bank reference; required for eSewa, Khalti and bank' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional({ description: 'Months it pays for, as the shop understands it' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;

  @ApiPropertyOptional({ description: 'The plan it pays for, by id' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  planId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'Screenshot, from POST /subscription/claims/proof' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  // Only one of our uploads: it is shown to admins in an <img>.
  @Matches(/^(\/api\/uploads\/|https:\/\/)/, { message: 'proofUrl must be an uploaded image' })
  proofUrl?: string;
}
