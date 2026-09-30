import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { ProductImageStorage, type UploadedImage } from '../products/product-image.storage';
import { productImageMulterOptions } from '../products/upload.config';
import { MulterErrorFilter } from '../products/multer-error.filter';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LogRetentionCron } from '../settings/log-retention.cron';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { SubscriptionPlanDto, UpdatePlatformSettingsDto } from './dto/platform.dto';
import type { SubscriptionPlan } from '../settings/settings.service';
import { PlatformDigestService } from './platform-digest.service';
import { PaymentGateways } from '../subscription/payment-gateways';

/**
 * Plans as stored: trimmed, prices shortest first, and every plan with an
 * id. An existing plan keeps its id -- shops on it point at it -- and a new
 * one gets one from its name. Two plans can't share a name (owners pick by
 * it), nor one plan two prices for the same length.
 */
function toPlans(input: SubscriptionPlanDto[]): SubscriptionPlan[] {
  const names = input.map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) throw new BadRequestException('Two plans have the same name');
  const taken = new Set(input.map((p) => p.id).filter(Boolean));
  return input.map((p) => {
    const lengths = p.prices.map((x) => x.months);
    if (new Set(lengths).size !== lengths.length) {
      throw new BadRequestException(`${p.name.trim()} has two prices for the same length`);
    }
    let id = p.id;
    if (!id) {
      const base = p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'plan';
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
    }
    return {
      id,
      name: p.name.trim(),
      description: p.description?.trim() || null,
      features: (p.features ?? []).map((f) => f.trim()).filter(Boolean),
      maxStores: p.maxStores ?? null,
      prices: [...p.prices]
        .sort((a, b) => a.months - b.months)
        .map((x) => ({ months: x.months, amount: x.amount, amountUsd: x.amountUsd ?? null })),
    };
  });
}

const TEXT_FIELDS = [
  'billingName',
  'billingTaxId',
  'billingAddress',
  'billingPhone',
  'billingEmail',
  'subscriptionPrice',
  'paymentInstructions',
] as const;

/** Admin panel → Settings. Reading is open to SUPPORT; changing is not. */
// @Public() skips the global tenant guard; PlatformAuthGuard enforces admin JWT.
@ApiTags('admin')
@ApiBearerAuth()
@Public()
@UseGuards(PlatformAuthGuard)
@Controller('admin/settings')
export class PlatformSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly images: ProductImageStorage,
    private readonly digest: PlatformDigestService,
    private readonly gateways: PaymentGateways,
  ) {}

  /**
   * Send the daily summary to yourself now, whatever the setting and even
   * with nothing in it -- to see what it looks like, or check mail works.
   */
  @Post('digest/send-me')
  sendDigestToMe(@CurrentActor() actor: Actor) {
    return this.digest.sendTo(actor.adminId!);
  }

  /**
   * A QR code for a payment method (eSewa, Khalti, a bank's QR). Stored the
   * way product images are; the returned url goes into paymentMethods[].qrUrl.
   */
  @Post('payment-qr')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image', productImageMulterOptions))
  @UseFilters(MulterErrorFilter)
  async uploadPaymentQr(@UploadedFile() file?: UploadedImage) {
    if (!file) throw new BadRequestException('No image uploaded');
    return { url: await this.images.save(file) };
  }

  @Get()
  async get() {
    const s = await this.settings.get();
    const cutoff = LogRetentionCron.cutoff(s.auditRetentionDays);
    const [total, oldest, pending, onPlans] = await Promise.all([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      cutoff ? this.prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } }) : 0,
      this.prisma.business.groupBy({ by: ['planId'], _count: { _all: true } }),
    ]);
    return {
      ...s,
      // What the trial falls back to when trialDays is null, for the form's hint.
      envTrialDays: Number(process.env.TRIAL_DAYS ?? 14),
      // eSewa / Khalti / connectIPS set up on the server (their keys are env only), for
      // the online plans card to say whether shops can actually pay.
      onlineGateways: this.gateways.available(),
      // Shops on each plan, by plan id; "none" for those on no plan (a trial,
      // or a plan since removed is counted under its old id).
      planUsage: Object.fromEntries(onPlans.map((g) => [g.planId ?? 'none', g._count._all])),
      activityLog: {
        total,
        oldestAt: oldest?.createdAt ?? null,
        // Entries the next retention run will delete.
        dueForRemoval: pending,
      },
    };
  }

  @Patch()
  async update(@CurrentActor() actor: Actor, @Body() dto: UpdatePlatformSettingsDto) {
    const before = await this.settings.get();
    // Turning the requirement on from an account without two-factor would
    // lock that admin out of this very page on the next click.
    if (dto.requireAdminTwoFactor && !before.requireAdminTwoFactor) {
      const me = await this.prisma.platformAdmin.findUnique({
        where: { id: actor.adminId! },
        select: { totpEnabledAt: true },
      });
      if (!me?.totpEnabledAt) {
        throw new BadRequestException('Turn on two-factor for your own account first (Account page).');
      }
    }
    const plans = dto.plans?.length ? toPlans(dto.plans) : dto.plans === undefined ? undefined : null;
    const data = {
      ...(dto.trialDays !== undefined ? { trialDays: dto.trialDays } : {}),
      ...(dto.signupOpen !== undefined ? { signupOpen: dto.signupOpen } : {}),
      ...(dto.maintenanceMessage !== undefined
        ? { maintenanceMessage: dto.maintenanceMessage?.trim() || null }
        : {}),
      ...(dto.auditRetentionDays !== undefined ? { auditRetentionDays: dto.auditRetentionDays } : {}),
      ...(dto.requireAdminTwoFactor !== undefined ? { requireAdminTwoFactor: dto.requireAdminTwoFactor } : {}),
      ...(dto.adminDigestEnabled !== undefined ? { adminDigestEnabled: dto.adminDigestEnabled } : {}),
      // Receipt details and how-to-pay text: blank clears, like the
      // maintenance message.
      ...Object.fromEntries(
        TEXT_FIELDS.filter((k) => dto[k] !== undefined).map((k) => [k, dto[k]?.trim() || null]),
      ),
      ...(dto.paymentMethods !== undefined
        ? {
            paymentMethods: dto.paymentMethods?.length
              ? dto.paymentMethods.map((m) => ({
                  label: m.label.trim(),
                  details: m.details.trim(),
                  qrUrl: m.qrUrl || null,
                }))
              : null,
          }
        : {}),
      ...(plans !== undefined ? { plans } : {}),
    };
    await this.settings.update(data, actor.email);
    // Only what changed, with its old value, so the admin log reads as a diff.
    const changes = Object.fromEntries(
      Object.entries(data)
        .filter(([k, v]) => JSON.stringify(before[k as keyof typeof data] ?? null) !== JSON.stringify(v ?? null))
        // Through JSON: a plan is a typed object, the log takes plain JSON.
        .map(([k, v]) => [k, { from: before[k as keyof typeof data], to: JSON.parse(JSON.stringify(v ?? null)) }]),
    );
    if (Object.keys(changes).length) {
      await this.audit.record(actor, 'settings.update', { details: changes });
    }
    return this.get();
  }
}
