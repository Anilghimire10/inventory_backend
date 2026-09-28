import { Injectable } from '@nestjs/common';
import { PlatformSettings } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** How long a read is reused. Short: an admin's change shows within this. */
const CACHE_MS = 30_000;

/** Trial length when neither the setting nor env TRIAL_DAYS says otherwise. */
const DEFAULT_TRIAL_DAYS = 14;

/**
 * Platform-wide settings (admin panel → Settings), read by signup, the trial,
 * the shop app's maintenance banner and the log-retention job.
 *
 * One row, created on first read with the schema defaults -- which are the
 * behaviour from before the settings existed -- so a fresh database needs no
 * seeding. Reads are cached per process for 30 seconds: the public status
 * endpoint is polled by every open shop tab.
 */
@Injectable()
export class SettingsService {
  private cached: { value: PlatformSettings; at: number } | null = null;

  constructor(private prisma: PrismaService) {}

  async get(): Promise<PlatformSettings> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const value = await this.prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    this.cached = { value, at: Date.now() };
    return value;
  }

  async update(
    data: Partial<
      Pick<
        PlatformSettings,
        | 'trialDays'
        | 'signupOpen'
        | 'maintenanceMessage'
        | 'auditRetentionDays'
        | 'billingName'
        | 'billingTaxId'
        | 'billingAddress'
        | 'billingPhone'
        | 'billingEmail'
        | 'requireAdminTwoFactor'
      >
    >,
    updatedBy: string,
  ): Promise<PlatformSettings> {
    const value = await this.prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...data, updatedBy },
      update: { ...data, updatedBy },
    });
    this.cached = { value, at: Date.now() };
    return value;
  }

  /** Trial length in days: the setting, else env TRIAL_DAYS, else 14. */
  async trialDays(): Promise<number> {
    const s = await this.get();
    if (s.trialDays != null) return s.trialDays;
    const env = Number(process.env.TRIAL_DAYS ?? DEFAULT_TRIAL_DAYS);
    return Number.isFinite(env) && env >= 0 ? env : DEFAULT_TRIAL_DAYS;
  }
}
