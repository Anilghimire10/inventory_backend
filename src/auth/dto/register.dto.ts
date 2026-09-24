import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessType, SalesModel } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Self-service signup: creates a Business + its first OWNER user + a default store. */
export class RegisterDto {
  @ApiProperty({ example: 'Green Grocer' })
  @IsString()
  @MaxLength(200)
  @MinLength(2)
  businessName: string;

  @ApiPropertyOptional({ enum: BusinessType, default: BusinessType.OTHER })
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @ApiPropertyOptional({ enum: SalesModel, default: SalesModel.RETAIL })
  @IsOptional()
  @IsEnum(SalesModel)
  salesModel?: SalesModel;

  @ApiPropertyOptional({ default: 'USD', description: '3-letter currency code' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Jane Owner' })
  @IsString()
  @MaxLength(200)
  @MinLength(2)
  name: string;

  @ApiProperty({ minLength: 8, example: 'sup3rsecret' })
  @IsString()
  @MaxLength(128)
  @MinLength(8)
  password: string;
}
