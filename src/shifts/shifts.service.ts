import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, Prisma, SaleStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/types/auth-user';
import { paginate } from '../common/dto/pagination.dto';
import { CloseShiftDto, OpenShiftDto, QueryShiftDto } from './dto/shift.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Roles that may work on -- and close -- a till someone else opened. */
const isManagement = (role: UserRole) =>
  role === UserRole.OWNER || role === UserRole.MANAGER;

/** Tenders that put physical cash in the drawer. */
const CASH_TENDERS: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.MIXED];

@Injectable()
export class ShiftsService {
  constructor(private prisma: PrismaService) {}

  /** Start a till session. One open shift per user, enforced by the DB. */
  async open(user: AuthUser, dto: OpenShiftDto) {
    let storeId = dto.storeId ?? user.storeId;
    if (!storeId) {
      const stores = await this.prisma.store.findMany({
        where: { businessId: user.businessId },
        select: { id: true },
        take: 2,
      });
      if (stores.length === 1) storeId = stores[0].id;
    }
    if (!storeId) throw new BadRequestException('No store specified for this shift');
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId: user.businessId },
    });
    if (!store) throw new NotFoundException('Store not found');

    try {
      return await this.prisma.shift.create({
        data: {
          businessId: user.businessId,
          storeId,
          userId: user.userId,
          openingFloat: dto.openingFloat,
          note: dto.note,
        },
      });
    } catch (err) {
      // Partial unique index on (userId) WHERE closedAt IS NULL. Checking in
      // JS first would let two concurrent requests both open a shift.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException(
          'You already have an open shift at this store — close it first',
        );
      }
      throw err;
    }
  }

  /**
   * The till the caller is working on at a given store, or null.
   *
   * Scoped by store because a user may have one open shift per store: an
   * owner switching branch gets that branch's till, and the one they left
   * stays open behind them rather than having to be closed first.
   *
   * An owner or manager with no till of their own at that store *joins* the
   * one already open there. A shift is a drawer, not a login: when the owner
   * steps up to the counter the cashier is standing at, their sales belong in
   * that cashier's drawer, and making them open a second shift for the same
   * physical till would split one drawer's cash across two Z reports that
   * neither of them could then reconcile.
   *
   * Joining is only ever automatic when there is exactly one open till to
   * join. With two running, which drawer the owner's cash goes into is a
   * question only the person standing there can answer, so this returns null
   * and the client asks (see `openAtStore`). Passing `preferShiftId` is that
   * answer coming back.
   */
  async current(user: AuthUser, storeId?: string, preferShiftId?: string) {
    const id = await this.resolveShiftId(user, storeId, preferShiftId);
    return id ? this.report(user.businessId, id, user.userId) : null;
  }

  /**
   * Which till the caller is on, as an id, or null for none.
   *
   * The single rule, used by `current()` for what the POS displays and by the
   * sale path for what a sale is stamped with. Two implementations of this
   * would eventually disagree, and the symptom would be a cashier's drawer
   * quietly short by the owner's sales.
   */
  async resolveShiftId(
    user: AuthUser,
    storeId?: string,
    preferShiftId?: string,
  ): Promise<string | null> {
    if (preferShiftId) return this.joinable(user, preferShiftId, storeId);

    const own = await this.prisma.shift.findFirst({
      where: {
        businessId: user.businessId,
        userId: user.userId,
        closedAt: null,
        ...(storeId ? { storeId } : {}),
      },
      select: { id: true },
      orderBy: { openedAt: 'desc' },
    });
    if (own) return own.id;

    if (!storeId || !isManagement(user.role)) return null;

    // Two is already the ambiguous case, so ask for two and stop.
    const open = await this.prisma.shift.findMany({
      where: { businessId: user.businessId, storeId, closedAt: null },
      select: { id: true },
      orderBy: { openedAt: 'asc' },
      take: 2,
    });
    return open.length === 1 ? open[0].id : null;
  }

  /**
   * Every till open at a store — what the client offers when `current()`
   * found more than one and had to ask which drawer the owner is on.
   *
   * Management only: it names who is on each till, which is not a cashier's
   * business, and only management can join one anyway.
   */
  async openAtStore(user: AuthUser, storeId: string) {
    const shifts = await this.prisma.shift.findMany({
      where: { businessId: user.businessId, storeId, closedAt: null },
      select: {
        id: true,
        openedAt: true,
        openingFloat: true,
        userId: true,
        user: { select: { id: true, name: true } },
        _count: { select: { sales: true } },
      },
      orderBy: { openedAt: 'asc' },
    });
    return shifts.map((s) => ({
      id: s.id,
      openedAt: s.openedAt,
      openingFloat: Number(s.openingFloat),
      openedBy: s.user,
      salesCount: s._count.sales,
      isOwnShift: s.userId === user.userId,
    }));
  }

  /**
   * Check that the caller may work on this shift, and hand back its id.
   *
   * Shared by `current()` and by the sale path, so the till the POS displays
   * and the drawer a sale lands in can never be resolved by two different
   * rules. Throws rather than returning null: the caller named a specific
   * shift, so silently falling back to another one would put their cash
   * somewhere they didn't ask for.
   */
  async joinable(user: AuthUser, shiftId: string, storeId?: string) {
    const shift = await this.prisma.shift.findFirst({
      where: {
        id: shiftId,
        businessId: user.businessId,
        closedAt: null,
        ...(storeId ? { storeId } : {}),
      },
      select: { id: true, userId: true },
    });
    if (!shift) {
      throw new NotFoundException('No open shift by that id at this store');
    }
    if (shift.userId !== user.userId && !isManagement(user.role)) {
      throw new ForbiddenException(
        'Only an owner or manager can work on someone else’s shift',
      );
    }
    return shift.id;
  }

  /**
   * X report (mid-shift, read-only) and Z report (after close) are the same
   * numbers — what separates them is whether `closedAt` is set.
   */
  async report(businessId: string, id: string, viewerId?: string) {
    const shift = await this.prisma.shift.findFirst({
      where: { id, businessId },
      include: {
        user: { select: { id: true, name: true } },
        store: { select: { id: true, name: true } },
      },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    const totals = await this.totals(id, Number(shift.openingFloat));
    return {
      ...shift,
      isOpen: shift.closedAt === null,
      // Whose drawer this is. The till shows "Ramesh's till" rather than
      // "your shift" when an owner has joined one, so nobody counts a drawer
      // believing it to be theirs.
      isOwnShift: viewerId ? shift.userId === viewerId : undefined,
      ...totals,
      // Once closed, the stored snapshot is the authority — a later return
      // against one of the shift's sales must not silently rewrite history.
      ...(shift.closedAt
        ? {
            expectedCash: Number(shift.expectedCash ?? 0),
            countedCash: Number(shift.countedCash ?? 0),
            variance: Number(shift.variance ?? 0),
          }
        : {}),
    };
  }

  /** Close the drawer: snapshot expected cash and the counted variance. */
  async close(user: AuthUser, id: string, dto: CloseShiftDto) {
    const shift = await this.prisma.shift.findFirst({
      where: { id, businessId: user.businessId },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    if (shift.closedAt) throw new BadRequestException('Shift is already closed');
    if (shift.userId !== user.userId && !isManagement(user.role)) {
      throw new ForbiddenException('Only the cashier or a manager can close this shift');
    }

    const totals = await this.totals(id, Number(shift.openingFloat));
    const variance = round2(dto.countedCash - totals.expectedCash);

    // Guarded update: closing twice (double click, retried request) must not
    // overwrite the first close's snapshot with a later one.
    const claimed = await this.prisma.shift.updateMany({
      where: { id, businessId: user.businessId, closedAt: null },
      data: {
        closedAt: new Date(),
        countedCash: dto.countedCash,
        expectedCash: totals.expectedCash,
        variance,
        ...(dto.note ? { note: dto.note } : {}),
      },
    });
    if (claimed.count === 0) throw new BadRequestException('Shift is already closed');

    return this.report(user.businessId, id, user.userId);
  }

  async findAll(businessId: string, q: QueryShiftDto) {
    const where: Prisma.ShiftWhereInput = {
      businessId,
      ...(q.storeId ? { storeId: q.storeId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.from || q.to
        ? {
            openedAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.shift.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          user: { select: { id: true, name: true } },
          store: { select: { id: true, name: true } },
          _count: { select: { sales: true } },
        },
        orderBy: { openedAt: 'desc' },
      }),
      this.prisma.shift.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  // ---- helpers ----

  /**
   * Everything the X/Z report shows, derived from the sales stamped with
   * this shift.
   *
   * ponytail: refunds are attributed to the shift that *made* the sale, not
   * the one that processed the return — nothing records when a return
   * happened or which drawer paid it out. Upgrade path: stamp shiftId on the
   * return (a Refund row) and split the two numbers.
   */
  private async totals(shiftId: string, openingFloat: number) {
    const sales = await this.prisma.sale.findMany({
      where: { shiftId, status: { not: SaleStatus.HELD } },
      select: {
        subtotal: true,
        discount: true,
        tax: true,
        total: true,
        amountPaid: true,
        paymentMethod: true,
        items: { select: { quantity: true, returnedQty: true, lineTotal: true } },
      },
    });

    const refundOf = (sale: (typeof sales)[number]) =>
      sale.items.reduce((sum, it) => {
        const qty = Number(it.quantity);
        const returned = Number(it.returnedQty);
        if (!returned || !qty) return sum;
        return sum + (Number(it.lineTotal) / qty) * returned;
      }, 0);

    const byTender = new Map<PaymentMethod, { count: number; amount: number }>();
    let gross = 0;
    let discounts = 0;
    let tax = 0;
    let refunds = 0;
    let cashIn = 0;
    let cashRefunds = 0;

    for (const sale of sales) {
      const refund = refundOf(sale);
      gross += Number(sale.total);
      discounts += Number(sale.discount);
      tax += Number(sale.tax);
      refunds += refund;
      const t = byTender.get(sale.paymentMethod) ?? { count: 0, amount: 0 };
      t.count += 1;
      t.amount += Number(sale.total);
      byTender.set(sale.paymentMethod, t);
      // Only tenders that actually moved cash affect the drawer. amountPaid
      // is what was handed over now (a CREDIT sale contributes nothing; a
      // MIXED one contributes the part that was paid).
      if (CASH_TENDERS.includes(sale.paymentMethod)) {
        cashIn += Number(sale.amountPaid);
        cashRefunds += refund;
      }
    }

    const expectedCash = round2(openingFloat + cashIn - cashRefunds);
    return {
      salesCount: sales.length,
      gross: round2(gross),
      discounts: round2(discounts),
      tax: round2(tax),
      refunds: round2(refunds),
      net: round2(gross - refunds),
      cashIn: round2(cashIn),
      cashRefunds: round2(cashRefunds),
      expectedCash,
      byTender: [...byTender.entries()].map(([method, v]) => ({
        method,
        count: v.count,
        amount: round2(v.amount),
      })),
    };
  }
}
