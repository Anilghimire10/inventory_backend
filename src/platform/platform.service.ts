import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BusinessType, Prisma, SaleStatus, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { MailService } from '../mail/mail.service';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';
import { normalizeEmail } from '../common/email';
import { TX_OPTS } from '../common/prisma-tx';
import {
  DAY_MS,
  daysUntil,
  paymentPeriod,
  subscriptionStatus,
  trialEndsAt,
} from '../common/subscription';
import { Actor, PlatformAuditService } from './platform-audit.service';
import { BusinessService } from '../business/business.service';
import { AuthService } from '../auth/auth.service';
import { isSubscriptionActive } from '../common/subscription';
import { SubscriptionRemindersService } from './subscription-reminders.service';
import {
  BusinessSort,
  CreateBusinessDto,
  CreateBusinessNoteDto,
  DeleteBusinessDto,
  QueryBusinessesDto,
  RecordPaymentDto,
  SubscriptionFilter,
  SuspendDto,
  UpdateBusinessDto,
} from './dto/platform.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

const ORDER_BY: Record<BusinessSort, Prisma.BusinessOrderByWithRelationInput> = {
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
  name: { name: 'asc' },
  sales: { sales: { _count: 'desc' } },
  expiry: { subscribedTo: { sort: 'asc', nulls: 'last' } },
};

/**
 * The Prisma filter behind each subscription label. Mirrors
 * subscriptionStatus() exactly, so filtering by "trial" returns precisely the
 * rows that are labelled "trial" -- plus "no-expiry", a subset of "active".
 */
export function subscriptionWhere(
  filter: SubscriptionFilter,
  now: Date,
  soonDays: number,
): Prisma.BusinessWhereInput {
  const soon = new Date(now.getTime() + soonDays * DAY_MS);
  switch (filter) {
    case 'inactive':
      return { isSubscribed: false };
    case 'expired':
      return { isSubscribed: true, subscribedTo: { lt: now } };
    case 'trial':
      return { isSubscribed: true, subscribedTo: { gte: now }, subscriptionPayments: { none: {} } };
    case 'expiring':
      return {
        isSubscribed: true,
        subscribedTo: { gte: now, lte: soon },
        subscriptionPayments: { some: {} },
      };
    case 'active':
      return {
        isSubscribed: true,
        OR: [
          { subscribedTo: null },
          { subscribedTo: { gt: soon }, subscriptionPayments: { some: {} } },
        ],
      };
    case 'no-expiry':
      return { isSubscribed: true, subscribedTo: null };
  }
}

/**
 * Cross-tenant operations for the super-admin panel. Unlike every other
 * service, these are deliberately NOT scoped by businessId.
 */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private audit: PlatformAuditService,
    private reminders: SubscriptionRemindersService,
    private business: BusinessService,
    private auth: AuthService,
    private settings: SettingsService,
  ) {}

  /** Platform-wide totals for the admin dashboard. */
  async stats() {
    const now = new Date();
    const [
      businesses,
      suspended,
      users,
      products,
      salesAgg,
      salesByCurrency,
      trial,
      expiringSoon,
      expired,
      inactive,
      recent,
    ] = await Promise.all([
      this.prisma.business.count(),
      this.prisma.business.count({ where: { isSuspended: true } }),
      this.prisma.user.count(),
      this.prisma.product.count(),
      this.prisma.sale.aggregate({
        where: { status: { not: SaleStatus.HELD } },
        _sum: { total: true },
        _count: true,
      }),
      // Sales can only be added up within one currency. Prisma can't group
      // sales by a column of their business, hence the SQL.
      this.prisma.$queryRaw<{ currency: string; total: Prisma.Decimal; count: bigint }[]>`
        SELECT b.currency, COALESCE(SUM(s.total), 0) AS total, COUNT(s.id) AS count
        FROM "Sale" s JOIN "Business" b ON b.id = s."businessId"
        WHERE s.status <> 'HELD'
        GROUP BY b.currency
        ORDER BY total DESC
      `,
      this.prisma.business.count({ where: subscriptionWhere('trial', now, 7) }),
      this.prisma.business.count({ where: subscriptionWhere('expiring', now, 7) }),
      this.prisma.business.count({ where: subscriptionWhere('expired', now, 7) }),
      this.prisma.business.count({ where: subscriptionWhere('inactive', now, 7) }),
      this.prisma.business.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, type: true, createdAt: true },
      }),
    ]);

    return {
      businesses,
      activeBusinesses: businesses - suspended,
      suspendedBusinesses: suspended,
      users,
      products,
      // Kept for the current overview card, but it adds different currencies
      // together -- use salesByCurrency.
      totalSalesValue: round2(Number(salesAgg._sum.total ?? 0)),
      totalTransactions: salesAgg._count,
      salesByCurrency: salesByCurrency.map((r) => ({
        currency: r.currency,
        total: round2(Number(r.total)),
        count: Number(r.count),
      })),
      subscriptions: { trial, expiringSoon, expired, inactive },
      recentBusinesses: recent,
    };
  }

  /** All businesses with high-level counts, filterable and sortable. */
  async listBusinesses(q: QueryBusinessesDto) {
    const now = new Date();
    const where: Prisma.BusinessWhereInput = {
      AND: [
        q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {},
        q.status ? { isSuspended: q.status === 'suspended' } : {},
        q.type ? { type: q.type } : {},
        q.subscription ? subscriptionWhere(q.subscription, now, q.days) : {},
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.business.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: [ORDER_BY[q.sort ?? 'newest'], { id: 'asc' }],
        select: {
          id: true,
          name: true,
          type: true,
          currency: true,
          isSuspended: true,
          suspendedReason: true,
          isSubscribed: true,
          subscribedTo: true,
          createdAt: true,
          _count: {
            select: {
              users: true,
              products: true,
              sales: true,
              stores: true,
              subscriptionPayments: true,
            },
          },
        },
      }),
      this.prisma.business.count({ where }),
    ]);
    const lastActive = await this.lastActive(rows.map((b) => b.id));
    const data = rows.map((b) => ({
      ...b,
      subscriptionStatus: subscriptionStatus(b, b._count.subscriptionPayments, now, q.days),
      lastActiveAt: lastActive.get(b.id) ?? null,
    }));
    return paginate(data, total, q.page, q.limit);
  }

  /**
   * When each business was last used: its latest sign-in or its latest sale,
   * whichever is later. A shop that stays signed in on one till for weeks
   * never logs in again, so sign-ins alone would call a busy shop idle.
   * GREATEST skips NULLs, so either one is enough.
   */
  private async lastActive(ids: string[]): Promise<Map<string, Date | null>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; at: Date | null }[]>`
      SELECT b.id, GREATEST(
        (SELECT MAX(a."createdAt") FROM "AuditLog" a
          WHERE a."businessId" = b.id AND a.action = 'auth.login'),
        (SELECT MAX(s."createdAt") FROM "Sale" s WHERE s."businessId" = b.id)
      ) AS at
      FROM "Business" b
      WHERE b.id IN (${Prisma.join(ids)})
    `;
    return new Map(rows.map((r) => [r.id, r.at]));
  }

  /** Full detail for one business: profile, users, totals, recent sales. */
  async getBusiness(id: string) {
    const business = await this.prisma.business.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            products: true,
            sales: true,
            stores: true,
            customers: true,
            subscriptionPayments: true,
          },
        },
        // Name and status only. Store.address and Store.phone exist but stay
        // with the tenant: the platform admin needs to know a branch exists,
        // not where it is. Widen this only behind an audited read.
        stores: { select: { id: true, name: true, isActive: true } },
        users: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            isActive: true,
            emailVerified: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!business) throw new NotFoundException('Business not found');

    const salesAgg = await this.prisma.sale.aggregate({
      where: { businessId: id, status: { not: SaleStatus.HELD } },
      _sum: { total: true },
      _count: true,
    });
    const recentSales = await this.prisma.sale.findMany({
      where: { businessId: id },
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        receiptNo: true,
        total: true,
        status: true,
        createdAt: true,
      },
    });

    const lastActive = await this.lastActive([id]);
    return {
      ...business,
      lastActiveAt: lastActive.get(id) ?? null,
      subscriptionStatus: subscriptionStatus(business, business._count.subscriptionPayments),
      totalSalesValue: round2(Number(salesAgg._sum.total ?? 0)),
      totalTransactions: salesAgg._count,
      recentSales,
    };
  }

  /**
   * Onboard a shop by hand: the business, its first store and a verified
   * owner, the same shape self-signup creates. Without a password the owner
   * is emailed an invite and sets one through "Forgot password".
   */
  async createBusiness(actor: Actor, dto: CreateBusinessDto) {
    const email = normalizeEmail(dto.ownerEmail);
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('A user with this email already exists');
    }
    // No password given: store a random one nobody knows, so the account
    // can only be entered through the reset flow the invite points to.
    const passwordHash = await argon2.hash(dto.password ?? randomBytes(32).toString('hex'));

    const trialDays = await this.settings.trialDays();
    const { business, owner } = await this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          name: dto.businessName,
          type: dto.type ?? BusinessType.OTHER,
          ...(dto.salesModel ? { salesModel: dto.salesModel } : {}),
          ...(dto.currency ? { currency: dto.currency.toUpperCase() } : {}),
          subscribedTo: dto.subscribedTo
            ? new Date(dto.subscribedTo)
            : trialEndsAt(trialDays),
        },
      });
      const store = await tx.store.create({
        data: { businessId: business.id, name: 'Main Store' },
      });
      const owner = await tx.user.create({
        data: {
          businessId: business.id,
          storeId: store.id,
          email,
          name: dto.ownerName,
          passwordHash,
          role: UserRole.OWNER,
          emailVerified: true,
        },
        select: { id: true, email: true, name: true, role: true },
      });
      return { business, owner };
    }, TX_OPTS);

    // The account exists either way; a mail outage only means the admin has
    // to pass the sign-in steps on by hand, so report it instead of failing.
    let inviteSent = false;
    if (!dto.password) {
      try {
        await this.mail.sendAccountInvite(email, dto.ownerName, business.name);
        inviteSent = true;
      } catch (e) {
        this.logger.warn(`Invite email to ${email} failed: ${(e as Error).message}`);
      }
    }

    await this.audit.record(actor, 'business.create', {
      businessId: business.id,
      targetUserId: owner.id,
      details: { name: business.name, ownerEmail: email, inviteSent },
    });
    return { business, owner, inviteSent };
  }

  async updateBusiness(actor: Actor, id: string, dto: UpdateBusinessDto) {
    const before = await this.getBusinessOrThrow(id);
    const updated = await this.prisma.business.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.currency ? { currency: dto.currency.toUpperCase() } : {}),
      },
    });
    await this.audit.record(actor, 'business.update', {
      businessId: id,
      details: {
        changes: { ...dto },
        before: Object.fromEntries(
          Object.keys(dto).map((k) => [k, before[k as keyof typeof before] as Prisma.JsonValue]),
        ),
      },
    });
    return updated;
  }

  async setSuspended(actor: Actor, id: string, dto: SuspendDto) {
    const business = await this.getBusinessOrThrow(id);
    const updated = await this.prisma.business.update({
      where: { id },
      data: dto.isSuspended
        ? { isSuspended: true, suspendedReason: dto.reason?.trim() || null, suspendedAt: new Date() }
        : { isSuspended: false, suspendedReason: null, suspendedAt: null },
      select: { id: true, name: true, isSuspended: true, suspendedReason: true, suspendedAt: true },
    });
    await this.audit.record(actor, dto.isSuspended ? 'business.suspend' : 'business.reactivate', {
      businessId: id,
      details: { name: business.name, reason: dto.reason ?? null },
    });
    return updated;
  }

  /**
   * Set the subscription directly (a manual override). Paying customers
   * should go through recordPayment so there is a record of the money.
   */
  async setSubscription(
    actor: Actor,
    id: string,
    isSubscribed: boolean,
    subscribedTo: string | null,
  ) {
    const before = await this.getBusinessOrThrow(id);
    const updated = await this.prisma.business.update({
      where: { id },
      data: {
        isSubscribed,
        subscribedTo: subscribedTo ? new Date(subscribedTo) : null,
      },
      select: { id: true, name: true, isSubscribed: true, subscribedTo: true },
    });
    await this.audit.record(actor, 'subscription.set', {
      businessId: id,
      details: {
        isSubscribed,
        subscribedTo,
        before: { isSubscribed: before.isSubscribed, subscribedTo: before.subscribedTo?.toISOString() ?? null },
      },
    });
    return updated;
  }

  // ---- Subscription payments (recorded by hand until online payment) ----

  async listPayments(businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where = { businessId };
    const [data, total] = await Promise.all([
      this.prisma.subscriptionPayment.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: { recordedByAdmin: { select: { id: true, name: true } } },
      }),
      this.prisma.subscriptionPayment.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  /** Record money received and extend the subscription, atomically. */
  async recordPayment(actor: Actor, businessId: string, dto: RecordPaymentDto) {
    const business = await this.getBusinessOrThrow(businessId);
    const { from, to, newEnd } = paymentPeriod({
      now: new Date(),
      currentEnd: business.isSubscribed ? business.subscribedTo : null,
      months: dto.months,
      periodFrom: dto.periodFrom ? new Date(dto.periodFrom) : undefined,
      periodTo: dto.periodTo ? new Date(dto.periodTo) : undefined,
    });

    const [payment, updated] = await this.prisma.$transaction([
      this.prisma.subscriptionPayment.create({
        data: {
          businessId,
          amount: dto.amount,
          currency: (dto.currency ?? business.currency).toUpperCase(),
          method: dto.method,
          reference: dto.reference,
          periodFrom: from,
          periodTo: to,
          note: dto.note,
          recordedByAdminId: actor.adminId,
        },
      }),
      this.prisma.business.update({
        where: { id: businessId },
        data: { isSubscribed: true, subscribedTo: newEnd },
        select: { id: true, name: true, isSubscribed: true, subscribedTo: true },
      }),
    ]);

    await this.audit.record(actor, 'payment.record', {
      businessId,
      details: {
        paymentId: payment.id,
        amount: dto.amount,
        currency: payment.currency,
        method: dto.method,
        periodFrom: from.toISOString(),
        periodTo: to.toISOString(),
        previousEnd: business.subscribedTo?.toISOString() ?? null,
      },
    });
    return { payment, business: updated };
  }

  /** "Send reminder now": bell notification + email to the owners. */
  async sendReminder(actor: Actor, businessId: string) {
    const business = await this.getBusinessOrThrow(businessId);
    if (!business.subscribedTo) {
      throw new BadRequestException('This business has no end date to remind about');
    }
    const daysLeft = daysUntil(business.subscribedTo);
    const res = await this.reminders.remind(
      { id: business.id, name: business.name, subscribedTo: business.subscribedTo },
      daysLeft,
      true,
    );
    await this.audit.record(actor, 'subscription.remind', {
      businessId,
      details: { daysLeft, emailed: res.emailed, failed: res.failed },
    });
    return { daysLeft, emailed: res.emailed, failed: res.failed };
  }

  // ---- Per-business drill-downs (super-admin) ----

  // ---- More read-only business tabs ----
  // Each is written to the admin log like the customers tab: the query and
  // the size of the answer, never the rows.

  /** Products with their total on hand across every store. */
  async businessProducts(actor: Actor, businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where: Prisma.ProductWhereInput = {
      businessId,
      // Variant parents hold no stock of their own; their variants are listed.
      variants: { none: {} },
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { sku: { contains: q.search, mode: 'insensitive' } },
              { barcode: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          variantName: true,
          sku: true,
          unit: true,
          costPrice: true,
          sellingPrice: true,
          reorderLevel: true,
          isActive: true,
        },
      }),
      this.prisma.product.count({ where }),
    ]);
    const stock = await this.prisma.stockItem.groupBy({
      by: ['productId'],
      where: { productId: { in: rows.map((r) => r.id) } },
      _sum: { quantity: true },
    });
    const onHand = new Map(stock.map((s) => [s.productId, Number(s._sum.quantity ?? 0)]));
    const data = rows.map((r) => ({ ...r, onHand: onHand.get(r.id) ?? 0 }));
    await this.audit.record(actor, 'business.products.view', {
      businessId,
      details: { search: q.search ?? null, page: q.page, returned: data.length, total },
    });
    return paginate(data, total, q.page, q.limit);
  }

  async businessPurchases(actor: Actor, businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where: Prisma.PurchaseWhereInput = {
      businessId,
      ...(q.search
        ? {
            OR: [
              { reference: { contains: q.search, mode: 'insensitive' } },
              { supplier: { name: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          reference: true,
          status: true,
          total: true,
          amountPaid: true,
          createdAt: true,
          receivedAt: true,
          supplier: { select: { name: true } },
          store: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.purchase.count({ where }),
    ]);
    await this.audit.record(actor, 'business.purchases.view', {
      businessId,
      details: { search: q.search ?? null, page: q.page, returned: data.length, total },
    });
    return paginate(data, total, q.page, q.limit);
  }

  async businessShifts(actor: Actor, businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where: Prisma.ShiftWhereInput = { businessId };
    const [data, total] = await Promise.all([
      this.prisma.shift.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { openedAt: 'desc' },
        select: {
          id: true,
          openedAt: true,
          closedAt: true,
          openingFloat: true,
          expectedCash: true,
          countedCash: true,
          variance: true,
          store: { select: { name: true } },
          user: { select: { name: true } },
          _count: { select: { sales: true } },
        },
      }),
      this.prisma.shift.count({ where }),
    ]);
    await this.audit.record(actor, 'business.shifts.view', {
      businessId,
      details: { page: q.page, returned: data.length, total },
    });
    return paginate(data, total, q.page, q.limit);
  }

  // ---- Internal notes ----

  async listNotes(businessId: string) {
    await this.getBusinessOrThrow(businessId);
    return this.prisma.businessNote.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        body: true,
        adminEmail: true,
        createdAt: true,
        admin: { select: { id: true, name: true } },
      },
    });
  }

  async addNote(actor: Actor, businessId: string, dto: CreateBusinessNoteDto) {
    await this.getBusinessOrThrow(businessId);
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('A note needs some text');
    const note = await this.prisma.businessNote.create({
      data: { businessId, adminId: actor.adminId, adminEmail: actor.email, body },
      select: {
        id: true,
        body: true,
        adminEmail: true,
        createdAt: true,
        admin: { select: { id: true, name: true } },
      },
    });
    await this.audit.record(actor, 'business.note.add', {
      businessId,
      details: { noteId: note.id },
    });
    return note;
  }

  async deleteNote(actor: Actor, businessId: string, noteId: string) {
    const { count } = await this.prisma.businessNote.deleteMany({
      where: { id: noteId, businessId },
    });
    if (count === 0) throw new NotFoundException('Note not found');
    await this.audit.record(actor, 'business.note.delete', {
      businessId,
      details: { noteId },
    });
    return { deleted: true };
  }

  // ---- View as owner ----

  /**
   * Open the shop app as the business's owner: read-only, for 30 minutes, in
   * a new tab. For support calls where "what do you see?" is quicker to
   * answer by looking.
   *
   * The token goes in the URL's #fragment, which browsers never send to a
   * server, so it stays out of access logs and Referer headers.
   */
  async impersonate(actor: Actor, businessId: string) {
    const b = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, name: true, isSuspended: true, isSubscribed: true, subscribedTo: true },
    });
    if (!b) throw new NotFoundException('Business not found');
    // The shop app would refuse the session for these anyway, with an error
    // aimed at the shop rather than the admin.
    if (b.isSuspended) throw new BadRequestException('The business is suspended, so its app is locked');
    if (!isSubscriptionActive(b)) {
      throw new BadRequestException('The subscription has lapsed, so its app is locked');
    }
    const owner = await this.prisma.user.findFirst({
      where: { businessId, role: UserRole.OWNER, isActive: true, emailVerified: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, businessId: true, tokenVersion: true },
    });
    if (!owner) throw new BadRequestException('The business has no active, verified owner to view as');

    const base =
      process.env.SHOP_APP_URL?.trim() ||
      (process.env.NODE_ENV === 'production' ? null : 'http://localhost:5173');
    if (!base) throw new BadRequestException('SHOP_APP_URL is not set on the API');

    // adminId is null only for a failed login; this route requires a signed-in admin.
    const { token, expiresAt } = this.auth.issueImpersonationToken(owner, {
      adminId: actor.adminId!,
      email: actor.email,
    });
    await this.audit.record(actor, 'business.impersonate', {
      businessId,
      targetUserId: owner.id,
      details: { owner: owner.email, expiresAt: expiresAt.toISOString() },
    });
    return {
      url: `${base.replace(/\/+$/, '')}/impersonate#token=${encodeURIComponent(token)}`,
      expiresAt,
      owner: { name: owner.name, email: owner.email },
    };
  }

  // ---- Export and deletion ----

  /**
   * Everything the business holds, as NDJSON -- the same export an owner can
   * download, for a deletion request or a shop leaving. Logged before the
   * first byte goes out: it is the largest read of tenant data there is.
   */
  async exportBusiness(actor: Actor, businessId: string) {
    const b = await this.getBusinessOrThrow(businessId);
    await this.audit.record(actor, 'business.export', { businessId });
    return { name: b.name, chunks: this.business.exportNdjson(businessId) };
  }

  /**
   * Delete a business and everything in it, for test and spam signups and
   * deletion requests. The admin types the business name to confirm.
   *
   * Not a single `business.delete`: six foreign keys are RESTRICT (sale and
   * purchase lines to products; sales, purchases and shifts to stores and
   * users), and Postgres checks RESTRICT as the cascade reaches each row, so
   * a business with any sales would fail partway through the cascade. Those
   * rows go first, explicitly, and the whole thing is one transaction.
   *
   * The log entry carries the name and the counts, not a businessId: the row
   * it would point at is gone, and earlier entries for the business lose
   * their link the same way (SET NULL).
   */
  async deleteBusiness(actor: Actor, businessId: string, dto: DeleteBusinessDto) {
    const b = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        _count: {
          select: { users: true, stores: true, products: true, customers: true, sales: true },
        },
      },
    });
    if (!b) throw new NotFoundException('Business not found');
    if (dto.confirmName.trim() !== b.name.trim()) {
      throw new BadRequestException('Type the business name exactly as shown to confirm');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.saleItem.deleteMany({ where: { sale: { businessId } } });
      await tx.purchaseItem.deleteMany({ where: { purchase: { businessId } } });
      await tx.sale.deleteMany({ where: { businessId } });
      await tx.purchase.deleteMany({ where: { businessId } });
      await tx.shift.deleteMany({ where: { businessId } });
      await tx.business.delete({ where: { id: businessId } });
    }, { ...TX_OPTS, timeout: 120_000 });

    await this.audit.record(actor, 'business.delete', {
      details: { businessId, name: b.name, counts: b._count },
    });
    return { deleted: true, name: b.name };
  }

  /** Customers of a business, paginated. */
  async businessCustomers(actor: Actor, businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { phone: { contains: q.search, mode: 'insensitive' } },
              { email: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          creditBalance: true,
          createdAt: true,
          _count: { select: { sales: true } },
        },
      }),
      this.prisma.customer.count({ where }),
    ]);
    // The query and the size of the answer, never the rows -- logging the
    // customers here would make the audit trail a second copy of the PII it
    // exists to protect.
    await this.audit.record(actor, 'business.customers.view', {
      businessId,
      details: { search: q.search ?? null, page: q.page, returned: data.length, total },
    });
    return paginate(data, total, q.page, q.limit);
  }

  /** Sales history of a business, paginated. */
  async businessSales(actor: Actor, businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const where: Prisma.SaleWhereInput = {
      businessId,
      ...(q.search
        ? { receiptNo: { contains: q.search, mode: 'insensitive' } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          receiptNo: true,
          total: true,
          status: true,
          paymentMethod: true,
          createdAt: true,
          customer: { select: { name: true } },
          user: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.sale.count({ where }),
    ]);
    await this.audit.record(actor, 'business.sales.view', {
      businessId,
      details: { search: q.search ?? null, page: q.page, returned: data.length, total },
    });
    return paginate(data, total, q.page, q.limit);
  }

  /** A single sale with its line items — "what they sold". */
  async businessSale(actor: Actor, businessId: string, saleId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, businessId },
      include: {
        items: true,
        customer: { select: { name: true } },
        user: { select: { name: true } },
        store: { select: { name: true } },
      },
    });
    if (!sale) throw new NotFoundException('Sale not found');
    await this.audit.record(actor, 'business.sale.view', {
      businessId,
      details: { saleId, receiptNo: sale.receiptNo },
    });
    return sale;
  }

  /** Global activity feed across every business (super-admin monitoring). */
  async activityFeed(actor: Actor, q: PaginationDto) {
    const where: Prisma.AuditLogWhereInput = q.search
      ? { action: { contains: q.search, mode: 'insensitive' } }
      : {};
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          business: { select: { id: true, name: true } },
          user: { select: { name: true, role: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    // Cross-tenant by definition, so it is the broadest read on the panel.
    await this.audit.record(actor, 'activity.view', {
      details: { search: q.search ?? null, page: q.page, returned: data.length, total },
    });
    return paginate(data, total, q.page, q.limit);
  }

  /** Activity log of a business, paginated. */
  async businessActivity(actor: Actor, businessId: string, q: PaginationDto) {
    await this.getBusinessOrThrow(businessId);
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { businessId },
        skip: q.skip,
        take: q.limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      }),
      this.prisma.auditLog.count({ where: { businessId } }),
    ]);
    await this.audit.record(actor, 'business.activity.view', {
      businessId,
      details: { page: q.page, returned: data.length, total },
    });
    return paginate(data, total, q.page, q.limit);
  }

  private async getBusinessOrThrow(id: string) {
    const b = await this.prisma.business.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Business not found');
    return b;
  }
}
