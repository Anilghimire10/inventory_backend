import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  BusinessType,
  PlatformRole,
  SalesModel,
  SubscriptionPaymentMethod,
} from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateIf,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

// ---- Admin auth & accounts ----

export class PlatformLoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  // Checked against an existing hash, so only a DoS bound -- a password
  // set before new ones were capped at 128 must still sign in.
  @MaxLength(1024)
  password: string;

  @ApiPropertyOptional({ description: 'The 6-digit code, for an admin with two-factor on' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;
}

export class TwoFactorCodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @MaxLength(10)
  code: string;
}

export class DisableTwoFactorDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1024)
  password: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @MaxLength(10)
  code: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1024)
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MaxLength(128)
  @MinLength(8)
  newPassword: string;
}

export class CreateAdminDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  @MinLength(2)
  name: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MaxLength(128)
  @MinLength(8)
  password: string;

  @ApiPropertyOptional({
    enum: PlatformRole,
    description: 'ADMIN (default) can change anything; SUPPORT is read-only apart from support tickets',
  })
  @IsOptional()
  @IsEnum(PlatformRole)
  role?: PlatformRole;
}

export class UpdateAdminDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ minLength: 8, description: 'Set a new password for this admin' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @MinLength(8)
  password?: string;

  @ApiPropertyOptional({
    description: "Turn off another admin's two-factor, e.g. after a lost phone. They can set it up again.",
  })
  @IsOptional()
  @IsBoolean()
  resetTwoFactor?: boolean;

  @ApiPropertyOptional({ enum: PlatformRole })
  @IsOptional()
  @IsEnum(PlatformRole)
  role?: PlatformRole;
}

export class QueryAuditLogDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  adminId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
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
  @MaxLength(200)
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
  @MaxLength(200)
  @MinLength(2)
  ownerName: string;

  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  ownerEmail: string;

  @ApiPropertyOptional({
    minLength: 8,
    description:
      'Initial password. Omit it to email the owner an invite; they then set a password with "Forgot password".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
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
  @MaxLength(200)
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
  @MaxLength(50)
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
  @MaxLength(100)
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
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({ description: "Email the receipt to the business's owners" })
  @IsOptional()
  @IsBoolean()
  emailReceipt?: boolean;
}

// ---- Shop users (support) ----

export class UpdateTenantUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({ description: 'Fix a mistyped email. The new address must be verified again.' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ---- Internal notes and deletion ----

export class CreateBusinessNoteDto {
  @ApiProperty({ description: 'A call, a payment promise, a setup detail' })
  @IsString()
  @MaxLength(2000)
  @MinLength(1)
  body: string;
}

export class DeleteBusinessDto {
  @ApiProperty({ description: "The business's name, typed out to confirm" })
  @IsString()
  @MaxLength(200)
  confirmName: string;
}

// ---- Email log ----

export const EMAIL_TYPES = [
  'verification',
  'password-reset',
  'receipt',
  'low-stock',
  'invite',
  'subscription-reminder',
  'announcement',
] as const;

export class QueryEmailLogDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['SENT', 'FAILED', 'LOGGED'] })
  @IsOptional()
  @IsIn(['SENT', 'FAILED', 'LOGGED'])
  status?: 'SENT' | 'FAILED' | 'LOGGED';

  @ApiPropertyOptional({ enum: EMAIL_TYPES })
  @IsOptional()
  @IsIn(EMAIL_TYPES)
  type?: (typeof EMAIL_TYPES)[number];
}

// ---- Announcements ----

export class SendAnnouncementDto {
  @ApiProperty({ example: 'Scheduled maintenance on Saturday' })
  @IsString()
  @MaxLength(120)
  @MinLength(3)
  title: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  @MinLength(1)
  body: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Businesses to send to. Omitted or empty: every business that is not suspended.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  businessIds?: string[];

  @ApiPropertyOptional({ description: "Also email each business's owners" })
  @IsOptional()
  @IsBoolean()
  email?: boolean;
}

/** Admin panel → Settings. A field left out is unchanged; null clears it. */
export class UpdatePlatformSettingsDto {
  @ApiPropertyOptional({ nullable: true, description: 'Trial days for new signups; null uses env TRIAL_DAYS' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number | null;

  @ApiPropertyOptional({ description: 'False makes signup invite-only (admins create businesses)' })
  @IsOptional()
  @IsBoolean()
  signupOpen?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Banner across the shop app; null or empty removes it' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(500)
  maintenanceMessage?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Delete shop activity-log entries older than this; null keeps them' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3650)
  auditRetentionDays?: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Our trading name, printed on subscription receipts' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(200)
  billingName?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Our PAN/VAT number, printed on receipts' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(50)
  billingTaxId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Our address, printed on receipts' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(300)
  billingAddress?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Our phone, printed on receipts' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(50)
  billingPhone?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Our email, printed on receipts' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(254)
  billingEmail?: string | null;
}

// ---- Renewals ----

export class QueryRenewalsDto {
  @ApiPropertyOptional({ description: 'Include subscriptions ending within this many days', default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days: number = 30;
}

export class RemindBusinessesDto {
  @ApiProperty({ type: [String], description: 'Businesses to remind now' })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  businessIds: string[];
}
