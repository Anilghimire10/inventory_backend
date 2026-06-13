import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessType } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';

/** Self-service signup: creates a Business + its first OWNER user + a default store. */
export class RegisterDto {
  @ApiProperty({ example: 'Green Grocer' })
  @IsString()
  @MinLength(2)
  businessName: string;

  @ApiPropertyOptional({ enum: BusinessType, default: BusinessType.OTHER })
  @IsOptional()
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @ApiPropertyOptional({ default: 'USD', description: '3-letter currency code' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Jane Owner' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ minLength: 8, example: 'sup3rsecret' })
  @IsString()
  @MinLength(8)
  password: string;
}
