import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LogRetentionCron } from '../settings/log-retention.cron';
import { PlatformAuthGuard } from './platform-auth.guard';
import { CurrentActor } from './current-admin.decorator';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { UpdatePlatformSettingsDto } from './dto/platform.dto';

const BILLING_FIELDS = [
  'billingName',
  'billingTaxId',
  'billingAddress',
  'billingPhone',
  'billingEmail',
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
  ) {}

  @Get()
  async get() {
    const s = await this.settings.get();
    const cutoff = LogRetentionCron.cutoff(s.auditRetentionDays);
    const [total, oldest, pending] = await Promise.all([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      cutoff ? this.prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } }) : 0,
    ]);
    return {
      ...s,
      // What the trial falls back to when trialDays is null, for the form's hint.
      envTrialDays: Number(process.env.TRIAL_DAYS ?? 14),
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
    const data = {
      ...(dto.trialDays !== undefined ? { trialDays: dto.trialDays } : {}),
      ...(dto.signupOpen !== undefined ? { signupOpen: dto.signupOpen } : {}),
      ...(dto.maintenanceMessage !== undefined
        ? { maintenanceMessage: dto.maintenanceMessage?.trim() || null }
        : {}),
      ...(dto.auditRetentionDays !== undefined ? { auditRetentionDays: dto.auditRetentionDays } : {}),
      // Receipt details: blank clears, like the maintenance message.
      ...Object.fromEntries(
        BILLING_FIELDS.filter((k) => dto[k] !== undefined).map((k) => [k, dto[k]?.trim() || null]),
      ),
    };
    await this.settings.update(data, actor.email);
    // Only what changed, with its old value, so the admin log reads as a diff.
    const changes = Object.fromEntries(
      Object.entries(data)
        .filter(([k, v]) => before[k as keyof typeof data] !== v)
        .map(([k, v]) => [k, { from: before[k as keyof typeof data], to: v }]),
    );
    if (Object.keys(changes).length) {
      await this.audit.record(actor, 'settings.update', { details: changes });
    }
    return this.get();
  }
}
