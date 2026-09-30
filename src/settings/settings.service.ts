import { Injectable } from '@nestjs/common';
import { PlatformSettings, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** One way to pay the platform: eSewa, Khalti, a bank account ... */
export interface PaymentMethodSetting {
  label: string;
  details: string;
  qrUrl?: string | null;
}

/** The lengths a plan can be sold for, in months. */
export const PLAN_LENGTHS = [1, 3, 12] as const;

/**
 * One price of a plan: `months` of subscription for `amount` NPR, and
 * optionally `amountUsd` for shops priced in dollars.
 */
export interface PlanPrice {
  months: number;
  amount: number;
  amountUsd?: number | null;
}

/**
 * The currency a shop is charged in: NPR for a shop keeping its books in
 * rupees, USD for any other. Plans are priced in those two only.
 */
export const pricingCurrency = (businessCurrency: string | null | undefined) =>
  (businessCurrency ?? 'NPR').toUpperCase() === 'NPR' ? 'NPR' : 'USD';

/** A plan as one shop sees it: its prices in that shop's currency. */
export interface PricedPlan extends Omit<SubscriptionPlan, 'prices'> {
  currency: 'NPR' | 'USD';
  prices: { months: number; amount: number }[];
}

/**
 * `plan` priced for a shop in `businessCurrency`. A dollar shop sees the
 * lengths the plan has a USD price for; a plan with none stays in NPR for it,
 * payable by bank or card like any other.
 */
export function pricedFor(plan: SubscriptionPlan, businessCurrency: string | null | undefined): PricedPlan {
  const usd = plan.prices.filter((p) => p.amountUsd != null && p.amountUsd > 0);
  const inUsd = pricingCurrency(businessCurrency) === 'USD' && usd.length > 0;
  return {
    ...plan,
    currency: inUsd ? 'USD' : 'NPR',
    prices: inUsd
      ? usd.map((p) => ({ months: p.months, amount: p.amountUsd! }))
      : plan.prices.map((p) => ({ months: p.months, amount: p.amount })),
  };
}

/**
 * A subscription plan shops choose from (admin panel -> Settings -> Plans).
 * `id` is stable across renames: a shop's Business.planId points at it.
 */
export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string | null;
  /** What's included, one short line each. */
  features: string[];
  /** Branches a shop on it may have open; null is unlimited. */
  maxStores: number | null;
  /** Shortest first; a length the plan isn't sold for is simply absent. */
  prices: PlanPrice[];
}

/**
 * Whether a shop with `activeStores` branches open fits `plan`. A plan too
 * small can't be bought: the shop would be over its limit from day one.
 */
export function planFits(plan: Pick<SubscriptionPlan, 'maxStores'> | null, activeStores: number) {
  return !plan || plan.maxStores === null || activeStores <= plan.maxStores;
}

const branches = (n: number) => `${n} branch${n === 1 ? '' : 'es'}`;

/** Why a shop can't buy `plan`: it has more branches open than the plan allows. */
export function planTooSmall(plan: Pick<SubscriptionPlan, 'name' | 'maxStores'>, activeStores: number) {
  return (
    `The ${plan.name} plan allows ${branches(plan.maxStores ?? 0)}, and you have ${branches(activeStores)} open. ` +
    'Pick a bigger plan, or close a branch in Settings first.'
  );
}

/** Why a shop can't open another branch: its plan's limit is reached. */
export function planFull(plan: Pick<SubscriptionPlan, 'name' | 'maxStores'>) {
  return (
    `Your ${plan.name} plan allows ${branches(plan.maxStores ?? 0)}. ` +
    'To open another, choose a bigger plan on the Subscription page.'
  );
}

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
        | 'subscriptionPrice'
        | 'paymentInstructions'
        | 'adminDigestEnabled'
      >
    > & { paymentMethods?: PaymentMethodSetting[] | null; plans?: SubscriptionPlan[] | null },
    updatedBy: string,
  ): Promise<PlatformSettings> {
    // JSON null has to be spelled out for Prisma; a plain null is refused.
    const { paymentMethods, plans, ...rest } = data;
    const json = {
      ...(paymentMethods === undefined
        ? {}
        : {
            paymentMethods:
              paymentMethods === null
                ? Prisma.DbNull
                : paymentMethods.map((m) => ({ label: m.label, details: m.details, qrUrl: m.qrUrl ?? null })),
          }),
      ...(plans === undefined
        ? {}
        : { plans: plans === null ? Prisma.DbNull : (plans as unknown as Prisma.InputJsonValue) }),
    };
    const value = await this.prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...rest, ...json, updatedBy },
      update: { ...rest, ...json, updatedBy },
    });
    this.cached = { value, at: Date.now() };
    return value;
  }

  /**
   * How shops pay, as the shop app shows it. The stored JSON is read
   * defensively: anything malformed is dropped rather than shown.
   */
  async paymentInfo() {
    const s = await this.get();
    const raw: unknown[] = Array.isArray(s.paymentMethods) ? s.paymentMethods : [];
    const methods = raw
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m))
      .map((m) => ({
        label: typeof m.label === 'string' ? m.label : '',
        details: typeof m.details === 'string' ? m.details : '',
        qrUrl: typeof m.qrUrl === 'string' && m.qrUrl ? m.qrUrl : null,
      }))
      .filter((m) => m.label);
    return {
      price: s.subscriptionPrice,
      instructions: s.paymentInstructions,
      methods,
    };
  }

  /**
   * The subscription plans, in the order the admin set. Read as defensively
   * as the payment methods: a malformed plan or price is dropped, never
   * charged, and a plan left with no price isn't offered.
   */
  async plans(): Promise<SubscriptionPlan[]> {
    const s = await this.get();
    const raw: unknown[] = Array.isArray(s.plans) ? s.plans : [];
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    return raw.filter(isObj).flatMap((p) => {
      const id = typeof p.id === 'string' ? p.id : '';
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      const prices = (Array.isArray(p.prices) ? p.prices : [])
        .filter(isObj)
        .map((x) => {
          const usd = Number(x.amountUsd);
          return {
            months: Number(x.months),
            amount: Number(x.amount),
            amountUsd: x.amountUsd != null && Number.isFinite(usd) && usd > 0 ? usd : null,
          };
        })
        .filter((x) => (PLAN_LENGTHS as readonly number[]).includes(x.months) && Number.isFinite(x.amount) && x.amount > 0)
        .sort((a, b) => a.months - b.months);
      if (!id || !name || !prices.length) return [];
      const maxStores = Number(p.maxStores);
      return [
        {
          id,
          name,
          description: typeof p.description === 'string' && p.description.trim() ? p.description.trim() : null,
          features: (Array.isArray(p.features) ? p.features : []).filter((f): f is string => typeof f === 'string' && !!f.trim()),
          maxStores: p.maxStores != null && Number.isInteger(maxStores) && maxStores > 0 ? maxStores : null,
          prices,
        },
      ];
    });
  }

  /** One plan by id; null for none, or one the admin has since removed. */
  async plan(id: string | null | undefined): Promise<SubscriptionPlan | null> {
    if (!id) return null;
    return (await this.plans()).find((p) => p.id === id) ?? null;
  }

  /** Trial length in days: the setting, else env TRIAL_DAYS, else 14. */
  async trialDays(): Promise<number> {
    const s = await this.get();
    if (s.trialDays != null) return s.trialDays;
    const env = Number(process.env.TRIAL_DAYS ?? DEFAULT_TRIAL_DAYS);
    return Number.isFinite(env) && env >= 0 ? env : DEFAULT_TRIAL_DAYS;
  }
}
