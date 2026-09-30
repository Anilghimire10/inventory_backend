import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  BusinessType,
  PaymentClaimStatus,
  PlatformRole,
  SalesModel,
  SubscriptionPaymentMethod,
} from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
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

/** A created-at window for the log lists: either end optional, ISO times. */
export class DateRangeQueryDto extends PaginationDto {
  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

/** `createdAt` within [from, to]; nothing when neither is given. */
export function createdBetween(q: { from?: string; to?: string }) {
  if (!q.from && !q.to) return {};
  return {
    createdAt: {
      ...(q.from ? { gte: new Date(q.from) } : {}),
      ...(q.to ? { lte: new Date(q.to) } : {}),
    },
  };
}

export class QueryAuditLogDto extends DateRangeQueryDto {
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

  @ApiPropertyOptional({ nullable: true, description: "The shop's plan, by id; null takes it off any plan (no branch limit)" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(40)
  planId?: string | null;
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

  @ApiPropertyOptional({ description: 'The plan it pays for, by id; the shop moves onto it' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  planId?: string;
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

  @ApiPropertyOptional({
    enum: ['all', 'trial', 'active', 'expiring', 'expired'],
    description: 'Who gets it, by subscription status. Ignored when businessIds is given.',
  })
  @IsOptional()
  @IsIn(['all', 'trial', 'active', 'expiring', 'expired'])
  audience?: 'all' | 'trial' | 'active' | 'expiring' | 'expired';

  @ApiPropertyOptional({ description: 'Send it later, up to 90 days ahead. Omitted or past: now.' })
  @IsOptional()
  @IsDateString()
  scheduledFor?: string;
}

/** One way shops can pay: shown on their Subscription page. */
export class PaymentMethodDto {
  @ApiProperty({ example: 'eSewa' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label: string;

  @ApiProperty({ example: 'eSewa ID 98XXXXXXXX (Inventory Pvt. Ltd.)' })
  @IsString()
  @MaxLength(500)
  details: string;

  @ApiPropertyOptional({ nullable: true, description: 'QR image, from POST /admin/settings/payment-qr' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(500)
  // Only an uploaded image or an https link: this is put in an <img> on
  // every owner's screen.
  @Matches(/^(\/api\/uploads\/|https:\/\/)/, { message: 'qrUrl must be an uploaded image' })
  qrUrl?: string | null;
}

/** One price of a plan: 1, 3 or 12 months of subscription, in NPR. */
export class PlanPriceDto {
  @ApiProperty({ enum: [1, 3, 12], example: 1 })
  @Type(() => Number)
  @IsIn([1, 3, 12])
  months: number;

  @ApiProperty({ example: 1500, description: 'NPR. Khalti takes nothing under NPR 10.' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(10)
  @Max(1_000_000)
  amount: number;

  @ApiPropertyOptional({ nullable: true, example: 15, description: 'USD, for shops outside Nepal; left out, they see NPR' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(100_000)
  amountUsd?: number | null;
}

/**
 * A subscription plan. Without an id it is new and gets one; with one it
 * keeps it, so the shops on it stay on it through a rename or a price change.
 */
export class SubscriptionPlanDto {
  @ApiPropertyOptional({ description: 'Leave out for a new plan' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]{1,40}$/)
  id?: string;

  @ApiProperty({ example: 'Business' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;

  @ApiPropertyOptional({ example: 'For shops with a few branches' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string | null;

  @ApiPropertyOptional({ type: [String], description: "What's included, up to 8 short lines" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  features?: string[];

  @ApiPropertyOptional({ nullable: true, description: 'Branches allowed; null or left out is unlimited', example: 3 })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxStores?: number | null;

  @ApiProperty({ type: [PlanPriceDto], description: '1 to 3 prices, one per length' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => PlanPriceDto)
  prices: PlanPriceDto[];
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

  @ApiPropertyOptional({ description: 'Make two-factor sign-in mandatory for every admin' })
  @IsOptional()
  @IsBoolean()
  requireAdminTwoFactor?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'What a subscription costs, as shops should read it' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(200)
  subscriptionPrice?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'What to do when paying, e.g. what to write in the remarks' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  paymentInstructions?: string | null;

  @ApiPropertyOptional({ description: "Send full admins the daily summary email" })
  @IsOptional()
  @IsBoolean()
  adminDigestEnabled?: boolean;

  @ApiPropertyOptional({ type: [PaymentMethodDto], nullable: true, description: 'Up to six; null or [] removes them' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => PaymentMethodDto)
  paymentMethods?: PaymentMethodDto[] | null;

  @ApiPropertyOptional({
    type: () => [SubscriptionPlanDto],
    nullable: true,
    description: 'Up to six, in the order owners see them; null or [] offers none',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => SubscriptionPlanDto)
  plans?: SubscriptionPlanDto[] | null;
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

// ---- Onboarding ----

export class QueryOnboardingDto {
  @ApiPropertyOptional({
    enum: ['trial', 'recent', 'all'],
    default: 'trial',
    description: 'trial: shops still on their free trial; recent: signed up in the last 30 days; all: every shop',
  })
  @IsOptional()
  @IsIn(['trial', 'recent', 'all'])
  scope: 'trial' | 'recent' | 'all' = 'trial';
}

// ---- Payment reports ("I've paid") ----

export class QueryPaymentClaimsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PaymentClaimStatus, default: PaymentClaimStatus.PENDING })
  @IsOptional()
  @IsEnum(PaymentClaimStatus)
  status?: PaymentClaimStatus;
}

/** Confirm a report: records the payment. Months default to what the shop said, else 1. */
export class ConfirmPaymentClaimDto {
  @ApiPropertyOptional({ description: 'Months it pays for. Give this or periodTo, not both.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;

  @ApiPropertyOptional({ description: 'Or an exact end date for the period' })
  @IsOptional()
  @IsDateString()
  periodTo?: string;

  @ApiPropertyOptional({ description: 'The plan it pays for, if not the one the shop reported' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  planId?: string;

  @ApiPropertyOptional({ description: 'The amount actually received, if not what the shop reported' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  emailReceipt?: boolean;
}

export class RejectPaymentClaimDto {
  @ApiProperty({ example: 'No eSewa payment with that transaction ID' })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}
