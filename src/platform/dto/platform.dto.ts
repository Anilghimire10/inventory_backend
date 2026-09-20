import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  BusinessType,
  SalesModel,
  SubscriptionPaymentMethod,
} from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

// ---- Admin auth & accounts ----

export class PlatformLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}

export class CreateAdminDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class UpdateAdminDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ minLength: 8, description: 'Set a new password for this admin' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

export class QueryAuditLogDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  adminId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  businessId?: string;
}

// ---- Businesses ----

export const SUBSCRIPTION_FILTERS = [
  'active',
  'trial',
  'expiring',
  'expired',
  'inactive',
  'no-expiry',
] as const;
export type SubscriptionFilter = (typeof SUBSCRIPTION_FILTERS)[number];

export const BUSINESS_SORTS = ['newest', 'oldest', 'name', 'sales', 'expiry'] as const;
export type BusinessSort = (typeof BUSINESS_SORTS)[number];

export class QueryBusinessesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['active', 'suspended'] })
  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';

  @ApiPropertyOptional({ enum: SUBSCRIPTION_FILTERS })
  @IsOptional()
  @IsIn(SUBSCRIPTION_FILTERS)
  subscription?: SubscriptionFilter;

  @ApiPropertyOptional({ enum: BusinessType })
  @IsOptional()
  @IsEnum(BusinessType)
  type?: BusinessType;

  @ApiPropertyOptional({ enum: BUSINESS_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(BUSINESS_SORTS)
  sort?: BusinessSort;

  @ApiPropertyOptional({ default: 7, description: 'Window for "expiring", in days' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days = 7;
}

export class CreateBusinessDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  businessName: string;

  @ApiPropertyOptional({ enum: BusinessType })
  @IsOptional()
  @IsEnum(BusinessType)
  type?: BusinessType;

  @ApiPropertyOptional({ enum: SalesModel })
  @IsOptional()
  @IsEnum(SalesModel)
  salesModel?: SalesModel;

  @ApiPropertyOptional({ description: '3-letter currency code', default: 'USD' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  ownerName: string;

  @ApiProperty()
  @IsEmail()
  ownerEmail: string;

  @ApiPropertyOptional({
    minLength: 8,
    description:
      'Initial password. Omit it to email the owner an invite; they then set a password with "Forgot password".',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @ApiPropertyOptional({ description: 'Paid-until date. Defaults to the standard trial.' })
  @IsOptional()
  @IsDateString()
  subscribedTo?: string;
}

export class UpdateBusinessDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ enum: BusinessType })
  @IsOptional()
  @IsEnum(BusinessType)
  type?: BusinessType;

  @ApiPropertyOptional({ enum: SalesModel })
  @IsOptional()
  @IsEnum(SalesModel)
  salesModel?: SalesModel;

  @ApiPropertyOptional({ description: '3-letter currency code' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({ description: 'PAN/VAT registration number' })
  @IsOptional()
  @IsString()
  taxId?: string;
}

export class SuspendDto {
  @ApiProperty()
  @IsBoolean()
  isSuspended: boolean;

  @ApiPropertyOptional({ description: "Shown to the business's users when sign-in is refused" })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class SetSubscriptionDto {
  @ApiProperty()
  @IsBoolean()
  isSubscribed: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateString()
  subscribedTo?: string | null;
}

export class RecordPaymentDto {
  @ApiProperty({ example: 1500 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @ApiPropertyOptional({ description: "Defaults to the business's currency" })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiProperty({ enum: SubscriptionPaymentMethod })
  @IsEnum(SubscriptionPaymentMethod)
  method: SubscriptionPaymentMethod;

  @ApiPropertyOptional({ description: 'Receipt number or bank reference' })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional({
    description: 'Months paid for. Give this or periodTo, not both.',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;

  @ApiPropertyOptional({
    description: 'Defaults to the current end date if still in the future, else today',
  })
  @IsOptional()
  @IsDateString()
  periodFrom?: string;

  @ApiPropertyOptional({ description: 'End of the paid period. Give this or months.' })
  @IsOptional()
  @IsDateString()
  periodTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

// ---- Shop users (support) ----

export class UpdateTenantUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ description: 'Fix a mistyped email. The new address must be verified again.' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
