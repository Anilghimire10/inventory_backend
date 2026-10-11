import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementReason,
  CashMovementType,
  PaymentMethod,
  PaymentType,
  Prisma,
  SaleStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TX_OPTS } from '../common/prisma-tx';
import { lockStoreTills } from '../common/store-lock';
import { AuthUser } from '../common/types/auth-user';
import { PaymentsService } from '../payments/payments.service';
import { paginate } from '../common/dto/pagination.dto';
import {
  CashMovementDto,
  CloseShiftDto,
  OpenShiftDto,
  QueryShiftDto,
} from './dto/shift.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Roles that may work on -- and close -- a till someone else opened. */
const isManagement = (role: UserRole) =>
  role === UserRole.OWNER || role === UserRole.MANAGER;

/**
 * Tenders that put physical cash in the drawer. MIXED only for rows written
 * before sales recorded the tender actually used: it was always taken to be
 * cash, and those rows keep reading the way they always did.
 */
const CASH_TENDERS: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.MIXED];

/** What a shift report reads alongside the shift. */
const REPORT_INCLUDE = {
  user: { select: { id: true, name: true } },
  store: { select: { id: true, name: true } },
  counter: { select: { id: true, name: true } },
  business: {
    select: { shiftBlindClose: true, shiftVarianceNoteOver: true },
  },
  cashMovements: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      type: true,
      reason: true,
      amount: true,
      note: true,
      createdAt: true,
      user: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ShiftInclude;

/** Who is looking at a report -- decides whose till it is, and blind close. */
type Viewer = Pick<AuthUser, 'userId' | 'role'>;

const toNumber = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/** Blind close applies to cashiers only: management always sees the figures. */
const isBlind = (setting: boolean, viewer?: Viewer) =>
  setting && viewer?.role === UserRole.CASHIER;

/** Which reasons make sense for each direction. OTHER fits either. */
const REASONS: Record<CashMovementType, CashMovementReason[]> = {
  [CashMovementType.PAY_IN]: [CashMovementReason.FLOAT_TOPUP, CashMovementReason.OTHER],
  [CashMovementType.PAY_OUT]: [
    CashMovementReason.EXPENSE,
    CashMovementReason.SUPPLIER,
    CashMovementReason.SAFE_DROP,
    CashMovementReason.OWNER_DRAW,
    CashMovementReason.OTHER,
  ],
};

/**
 * A count by denomination, checked and cleaned for storing.
 *
 * It has to add up to the counted total: the total is what the variance is
 * worked out from, and a breakdown that disagrees with it would leave the Z
 * report contradicting itself about what was in the drawer. Zero rows are
 * dropped -- "no 2-rupee coins" is not worth keeping.
 */
function checkCashCount(count: Record<string, number>, countedCash: number) {
  const entries = Object.entries(count);
  if (entries.length > 30) {
    throw new BadRequestException('Too many denominations in the cash count');
  }
  const clean: Record<string, number> = {};
  let sum = 0;
  for (const [denomination, qty] of entries) {
    const value = Number(denomination);
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(qty) || qty < 0) {
      throw new BadRequestException(
        'Each cash count line needs a positive denomination and a whole number of notes or coins',
      );
    }
    if (qty === 0) continue;
    clean[denomination] = qty;
    sum += value * qty;
  }
  if (round2(sum) !== round2(countedCash)) {
    throw new BadRequestException(
      `The notes and coins add up to ${round2(sum).toFixed(2)}, not the ${round2(countedCash).toFixed(2)} counted`,
    );
  }
  return clean;
}

/**
 * Refuses cash that would be booked to no till because several are open and
 * the caller named none. The client shows a till picker on this code.
 */
export const chooseTill = (direction: 'in' | 'out') =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'TILL_CHOICE',
    message: `Several tills are open here. Choose which till the cash ${direction === 'out' ? 'comes out of' : 'goes into'}.`,
  });

/** Thrown when money is booked to a till that has been counted and closed. */
const shiftClosed = () =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'SHIFT_CLOSED',
    message: 'This till was just closed. Reload the till to carry on.',
  });

/**
 * Keep a till open until the caller's transaction commits, or refuse if it
 * has already closed.
 *
 * Every write that books money to a shift -- a sale, a refund, cash taken
 * against credit -- resolves the shift before its transaction starts, so by
 * the time it writes, someone may have counted the drawer and closed it. The
 * sale's foreign key doesn't stop that: it takes a KEY SHARE lock, which a
 * close's UPDATE doesn't wait for. So the sale committed against a closed
 * shift, its cash missing from the Z report's expected figure while its total
 * showed in the gross -- a drawer over or short with nothing to say why.
 *
 * FOR SHARE does conflict with the close's row lock. Sales on the same till
 * still don't wait for each other; they only wait for a close in progress,
 * and one that waited re-reads the row, finds it closed, and is refused.
 */
export async function holdShiftOpen(
  tx: Prisma.TransactionClient,
  shiftId: string | null | undefined,
) {
  if (!shiftId) return;
  const open = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Shift" WHERE id = ${shiftId} AND "closedAt" IS NULL FOR SHARE
  `;
  if (open.length === 0) throw shiftClosed();
}

@Injectable()
export class ShiftsService {
  constructor(
    private prisma: PrismaService,
    private payments: PaymentsService,
  ) {}

  /**
   * Start a till session on a counter, or resume the caller's one already
   * open at this store. One open shift per user per store, and one per
   * counter -- one drawer, one count -- both enforced by the DB.
   *
   * A cashier opens the counter they are assigned to and no other: the owner
   * set it up for them, and their drawer is that counter's. An owner or
   * manager chooses: with one counter at the store it is that one; with
   * several they name it (COUNTER_CHOICE otherwise). A counter already open is
   * refused (COUNTER_BUSY): an owner works on its shift instead (see
   * `current`), and a cashier waits for it to be counted out.
   */
  async open(user: AuthUser, dto: OpenShiftDto) {
    let storeId = dto.storeId ?? user.storeId;
    let counterId = dto.counterId;
    const isCashier = user.role === UserRole.CASHIER;

    if (isCashier) {
      const mine = await this.assignedCounter(user.userId);
      if (counterId && counterId !== mine.id) {
        throw new ForbiddenException(`You can only open your own counter, ${mine.name}`);
      }
      if (dto.storeId && dto.storeId !== mine.storeId) {
        throw new ForbiddenException(`Your counter, ${mine.name}, is at another store`);
      }
      counterId = mine.id;
      storeId = mine.storeId;
    }

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
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    const atStore = storeId;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Opens at one store take turns, and so does taking a counter out of
        // use or assigning a cashier to one: every read below is the settled
        // answer, made once.
        await lockStoreTills(tx, atStore);

        const own = await tx.shift.findFirst({
          where: { businessId: user.businessId, userId: user.userId, storeId: atStore, closedAt: null },
          include: { counter: { select: { name: true } } },
        });
        // No counter named and a till of their own already open here -- a
        // second tab, a retry, an older app: hand it back rather than ask.
        if (own && !counterId) return own;

        const counter = await this.counterToOpen(tx, user.businessId, atStore, counterId);
        if (own) return this.resumeOwn(tx, own, counter, user.role);

        const busy = await tx.shift.findFirst({
          where: { counterId: counter.id, closedAt: null },
          include: { user: { select: { name: true } } },
        });
        if (busy) {
          // A cashier at their own counter works on the till already open
          // there -- an owner or manager may have opened it first. One drawer
          // has one session, and every sale says who rang it up.
          if (isCashier) return busy;
          throw this.counterBusy(counter.name, busy.user.name, user.role);
        }

        // Read server-side rather than trusted from the client: it is the
        // figure this shift's opening count is checked against.
        const carried = await this.lastLeftInDrawer(user.businessId, atStore, counter.id, tx);

        return tx.shift.create({
          data: {
            businessId: user.businessId,
            storeId: atStore,
            counterId: counter.id,
            userId: user.userId,
            openingFloat: dto.openingFloat,
            carriedFloat: carried?.amount ?? null,
            note: dto.note,
          },
        });
      }, TX_OPTS);
    } catch (err) {
      // A partial unique index -- (userId, storeId) or the counter's -- caught
      // what the checks above raced past. Checking in JS alone would let two
      // concurrent requests both open a shift. Settle it the way the checks
      // would have, under the lock; whatever is left is a race lost a moment
      // ago, and trying again gets the settled answer.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.$transaction(async (tx) => {
          await lockStoreTills(tx, atStore);
          const counter = await this.counterToOpen(tx, user.businessId, atStore, counterId);
          const own = await tx.shift.findFirst({
            where: { businessId: user.businessId, userId: user.userId, storeId: atStore, closedAt: null },
            include: { counter: { select: { name: true } } },
          });
          if (own) return this.resumeOwn(tx, own, counter, user.role);
          const busy = await tx.shift.findFirst({
            where: { counterId: counter.id, closedAt: null },
            include: { user: { select: { name: true } } },
          });
          if (busy && isCashier) return busy;
          if (busy) throw this.counterBusy(counter.name, busy.user.name, user.role);
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'COUNTER_RETRY',
            message: `${counter.name} was being opened at the same moment. Try again.`,
          });
        }, TX_OPTS);
      }
      throw err;
    }
  }

  /**
   * The caller already has a till open at this store, and asked for a
   * counter. Theirs if it is that counter. A till from before counters
   * belongs to none -- nothing stopped a second shift on its drawer -- so
   * opened as this counter it becomes this counter's, if no one else is on it.
   * Any other counter of theirs is refused: one till of their own per store.
   */
  private async resumeOwn(
    tx: Prisma.TransactionClient,
    own: { id: string; counterId: string | null; counter: { name: string } | null },
    counter: { id: string; name: string },
    role: UserRole,
  ) {
    if (own.counterId === counter.id) return tx.shift.findUniqueOrThrow({ where: { id: own.id } });
    if (own.counterId === null) {
      await this.assertCounterFree(tx, counter, role);
      return tx.shift.update({ where: { id: own.id }, data: { counterId: counter.id } });
    }
    throw this.ownShiftOpen(own.counter?.name, counter.name);
  }

  /** A cashier's assigned counter id, or null. */
  private async cashierCounterId(userId: string) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { counterId: true } });
    return me?.counterId ?? null;
  }

  /**
   * Whether this user may sell into, move cash on, or close a shift: their
   * own; anyone's, for an owner or manager; and for a cashier, the one at
   * the counter they are assigned to -- the drawer they stand at, whoever
   * counted it in.
   */
  private async mayWorkOn(
    user: Pick<AuthUser, 'userId' | 'role'>,
    shift: { userId: string; counterId: string | null },
  ) {
    if (shift.userId === user.userId || isManagement(user.role)) return true;
    if (user.role !== UserRole.CASHIER || !shift.counterId) return false;
    return (await this.cashierCounterId(user.userId)) === shift.counterId;
  }

  /** The counter a cashier is assigned to, or a refusal saying how to fix it. */
  private async assignedCounter(userId: string) {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { counter: { select: { id: true, name: true, storeId: true, isActive: true } } },
    });
    const counter = me?.counter;
    if (!counter || !counter.isActive) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'NO_COUNTER',
        message: 'You are not assigned to a counter. Ask the owner to assign you one in Staff.',
      });
    }
    return counter;
  }

  /**
   * Which counter a shift opens on: the one named, if it is in use at this
   * store; else the store's only one. With several and none named, which
   * drawer is being counted in is a choice for the person at the till.
   */
  private async counterToOpen(
    db: Prisma.TransactionClient,
    businessId: string,
    storeId: string,
    counterId?: string,
  ) {
    if (counterId) {
      const counter = await db.counter.findFirst({
        where: { id: counterId, businessId, storeId },
        select: { id: true, name: true, isActive: true },
      });
      if (!counter) throw new NotFoundException('Counter not found at this store');
      if (!counter.isActive) throw new BadRequestException(`${counter.name} is no longer in use`);
      return counter;
    }
    const counters = await db.counter.findMany({
      where: { businessId, storeId, isActive: true },
      select: { id: true, name: true, isActive: true },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    if (counters.length === 0) {
      throw new BadRequestException('This store has no counter. Add one in Settings → Stores.');
    }
    if (counters.length > 1) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'COUNTER_CHOICE',
        message: 'This store has more than one counter. Choose which one to open.',
      });
    }
    return counters[0];
  }

  /** Refuses a counter with a shift already open on it. */
  private async assertCounterFree(
    db: Prisma.TransactionClient | PrismaService,
    counter: { id: string; name: string },
    role: UserRole,
  ) {
    const busy = await db.shift.findFirst({
      where: { counterId: counter.id, closedAt: null },
      select: { user: { select: { name: true } } },
    });
    if (busy) throw this.counterBusy(counter.name, busy.user.name, role);
  }

  private ownShiftOpen(open: string | undefined, asked: string) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'OWN_SHIFT_OPEN',
      message: `You already have ${open ?? 'a till'} open here. Close it before opening ${asked}.`,
    });
  }

  private counterBusy(counter: string, by: string, role: UserRole) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'COUNTER_BUSY',
      message: isManagement(role)
        ? `${counter} is already open on ${by}’s shift. Work on it, or choose another counter.`
        : `${counter} is already open on ${by}’s shift. It has to be closed before you open yours.`,
    });
  }

  /**
   * What the last shift closed on this counter left in its drawer, or null.
   *
   * Only ever the most recent close: if that cashier didn't say what they
   * left, reaching back to an older shift would offer a float from a drawer
   * that has been counted and emptied since. Per counter rather than per
   * user, because the drawer stays at the counter when the cashier goes home.
   * At a store with one counter, shifts from before counters (none named)
   * still count, so the first opening after the change is checked against
   * what was left then.
   */
  private async lastLeftInDrawer(
    businessId: string,
    storeId: string,
    counterId: string | null,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    // Closes from before counters name no drawer. With one counter at the
    // store they were that drawer; with several -- counting those since taken
    // out of use, which were drawers then -- any one of them could have been
    // another counter's, and its leftover cash would be checked against the
    // wrong drawer.
    const legacyIsThisDrawer = !!counterId && (await db.counter.count({ where: { storeId } })) === 1;
    const last = await db.shift.findFirst({
      where: {
        businessId,
        storeId,
        closedAt: { not: null },
        ...(counterId ? (legacyIsThisDrawer ? { OR: [{ counterId }, { counterId: null }] } : { counterId }) : {}),
      },
      orderBy: { closedAt: 'desc' },
      select: {
        cashLeft: true,
        closedAt: true,
        user: { select: { name: true } },
      },
    });
    if (!last || last.cashLeft === null) return null;
    return {
      amount: Number(last.cashLeft),
      closedAt: last.closedAt,
      closedBy: last.user.name,
    };
  }

  /**
   * The opening float to offer: whatever the previous shift on this counter
   * left behind. A cashier's counter is theirs whatever the client says.
   */
  async suggestedFloat(user: AuthUser, storeId: string, counterId?: string) {
    if (user.role === UserRole.CASHIER) {
      counterId = (await this.cashierCounterId(user.userId)) ?? undefined;
    } else if (!counterId) {
      // No counter named: the store's only one, if it has just one. With
      // several, the store-wide last close could be another drawer's cash.
      const counters = await this.prisma.counter.findMany({
        where: { storeId, isActive: true },
        select: { id: true },
        take: 2,
      });
      if (counters.length !== 1) return null;
      counterId = counters[0].id;
    }
    return this.lastLeftInDrawer(user.businessId, storeId, counterId ?? null);
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
   * answer coming back. The POS asks even with one running -- work on it, or
   * open your own -- and always sends its answer; the automatic join is the
   * fallback for a caller that names no till.
   */
  async current(user: AuthUser, storeId?: string, preferShiftId?: string) {
    const id = await this.resolveShiftId(user, storeId, preferShiftId);
    return id ? this.report(user.businessId, id, user) : null;
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
    return (await this.tillFor(user, storeId, preferShiftId)).shiftId;
  }

  /**
   * `resolveShiftId`, saying also when there was no till only because it was
   * ambiguous: an owner or manager with none of their own at a store where
   * two or more are open. A sale can't get there (the POS asks which till
   * before it sells), but cash handed back on a return or taken against
   * credit can -- and booked to no till, it leaves the drawer it really went
   * through over or short at close, with the cashier blamed. Callers moving
   * cash refuse that case (see `chooseTill`) rather than guess.
   */
  async tillFor(
    user: AuthUser,
    storeId?: string,
    preferShiftId?: string,
  ): Promise<{ shiftId: string | null; ambiguous: boolean }> {
    if (preferShiftId) {
      return { shiftId: await this.joinable(user, preferShiftId, storeId), ambiguous: false };
    }

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
    if (own) return { shiftId: own.id, ambiguous: false };

    // A cashier with none of their own works on the till open at their
    // counter, whoever opened it -- there is only the one drawer there.
    if (user.role === UserRole.CASHIER) {
      const counterId = await this.cashierCounterId(user.userId);
      if (!counterId) return { shiftId: null, ambiguous: false };
      const atCounter = await this.prisma.shift.findFirst({
        where: { businessId: user.businessId, counterId, closedAt: null, ...(storeId ? { storeId } : {}) },
        select: { id: true },
      });
      return { shiftId: atCounter?.id ?? null, ambiguous: false };
    }
    if (!isManagement(user.role)) return { shiftId: null, ambiguous: false };
    // Asked without a store -- an owner on "all stores" -- a shop with only
    // one has nothing to disambiguate: that's where the till is. With several
    // it stays a question for the client.
    if (!storeId) {
      const stores = await this.prisma.store.findMany({
        where: { businessId: user.businessId, isActive: true },
        select: { id: true },
        take: 2,
      });
      if (stores.length !== 1) return { shiftId: null, ambiguous: false };
      storeId = stores[0].id;
    }

    // Two is already the ambiguous case, so ask for two and stop.
    const open = await this.prisma.shift.findMany({
      where: { businessId: user.businessId, storeId, closedAt: null },
      select: { id: true },
      orderBy: { openedAt: 'asc' },
      take: 2,
    });
    return open.length === 1
      ? { shiftId: open[0].id, ambiguous: false }
      : { shiftId: null, ambiguous: open.length > 1 };
  }

  /**
   * Every till open at a store — what an owner or manager chooses from: work
   * on one of these (a cashier's, or another owner's or manager's), or open
   * their own.
   *
   * Management only: it names who is on each till, which is not a cashier's
   * business, and only management can join one anyway. The opener's role is
   * included so the choice can say whose drawer it is, not just a name.
   */
  async openAtStore(user: AuthUser, storeId: string) {
    const shifts = await this.prisma.shift.findMany({
      where: { businessId: user.businessId, storeId, closedAt: null },
      select: {
        id: true,
        openedAt: true,
        openingFloat: true,
        userId: true,
        user: { select: { id: true, name: true, role: true } },
        counter: { select: { id: true, name: true } },
        _count: { select: { sales: true } },
      },
      orderBy: { openedAt: 'asc' },
    });
    return shifts.map((s) => ({
      id: s.id,
      openedAt: s.openedAt,
      openingFloat: Number(s.openingFloat),
      openedBy: s.user,
      counter: s.counter,
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
      select: { id: true, userId: true, counterId: true },
    });
    if (!shift) throw shiftClosed();
    if (!(await this.mayWorkOn(user, shift))) {
      throw new ForbiddenException(
        'Only an owner or manager can work on someone else’s shift, or a cashier on the till at their own counter',
      );
    }
    return shift.id;
  }

  /**
   * X report (mid-shift, read-only) and Z report (after close) are the same
   * numbers — what separates them is whether `closedAt` is set.
   *
   * With blind close on, a cashier gets the report without anything that
   * says what the drawer should hold: no expected cash, no variance, and
   * none of the figures it is built from. Owners and managers always see the
   * lot.
   *
   * A cashier only ever sees their own shifts. They can't join anyone else's
   * till, so another drawer's count is none of their business -- and with
   * blind close off, it would hand them a colleague's expected cash and
   * variance just for knowing a shift id, which every sale carries. Not found
   * rather than forbidden, so it doesn't confirm the shift exists.
   */
  async report(
    businessId: string,
    id: string,
    viewer?: Viewer,
    /** The caller already checked the viewer may work on it (close does). */
    accessChecked = false,
  ) {
    const find = (where: Prisma.ShiftWhereInput) =>
      this.prisma.shift.findFirst({ where: { id, businessId, ...where }, include: REPORT_INCLUDE });
    let shift = await find(
      viewer && !isManagement(viewer.role) && !accessChecked ? { userId: viewer.userId } : {},
    );
    // A cashier also reads the till open at their counter that they are
    // working on -- looked up only when it isn't their own, the usual case.
    if (!shift && viewer?.role === UserRole.CASHIER) {
      const counterId = await this.cashierCounterId(viewer.userId);
      if (counterId) shift = await find({ counterId, closedAt: null });
    }
    if (!shift) throw new NotFoundException('Shift not found');
    const { business, cashMovements, ...row } = shift;
    const totals = await this.totals(id, Number(shift.openingFloat));
    const report = {
      ...row,
      isOpen: shift.closedAt === null,
      // Whose drawer this is. The till shows "Ramesh's till" rather than
      // "your shift" when an owner has joined one, so nobody counts a drawer
      // believing it to be theirs.
      isOwnShift: viewer ? shift.userId === viewer.userId : undefined,
      ...totals,
      movements: cashMovements.map((m) => ({ ...m, amount: Number(m.amount) })),
      carriedFloat: toNumber(shift.carriedFloat),
      cashLeft: toNumber(shift.cashLeft),
      varianceNoteOver: toNumber(business.shiftVarianceNoteOver),
      blindClose: isBlind(business.shiftBlindClose, viewer),
      // Once closed, the stored snapshot is the authority — a later return
      // against one of the shift's sales must not silently rewrite history.
      // Shifts closed before refunds were snapshotted have none, and show the
      // live figure as they always did.
      ...(shift.closedAt
        ? {
            expectedCash: Number(shift.expectedCash ?? 0),
            countedCash: Number(shift.countedCash ?? 0),
            variance: Number(shift.variance ?? 0),
            ...(shift.refundsAtClose !== null
              ? {
                  refunds: Number(shift.refundsAtClose),
                  net: round2(totals.gross - Number(shift.refundsAtClose)),
                }
              : {}),
          }
        : {}),
    };
    if (!report.blindClose) return report;
    return {
      ...report,
      expectedCash: null,
      variance: null,
      cashIn: null,
      cashRefunds: null,
      creditCollected: null,
      // Cash sales by tender is most of the expected figure on its own.
      byTender: [],
    };
  }

  /**
   * Close the drawer: snapshot expected cash and the counted variance.
   *
   * Runs with the shift row locked, so a pay out recorded at the same moment
   * either lands before the snapshot (and is in it) or is refused because the
   * shift has closed -- never recorded against a Z report that doesn't
   * include it.
   */
  async close(user: AuthUser, id: string, dto: CloseShiftDto) {
    const shift = await this.prisma.shift.findFirst({
      where: { id, businessId: user.businessId },
      include: {
        business: {
          select: { shiftBlindClose: true, shiftVarianceNoteOver: true },
        },
      },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    if (shift.closedAt) throw new BadRequestException('Shift is already closed');
    if (!(await this.mayWorkOn(user, shift))) {
      throw new ForbiddenException('Only the cashier at this counter or a manager can close this shift');
    }
    if (dto.cashLeft !== undefined && dto.cashLeft > dto.countedCash) {
      throw new BadRequestException(
        'Cash left for the next shift can’t be more than the cash counted',
      );
    }
    const cashCount =
      dto.cashCount === undefined
        ? undefined
        : checkCashCount(dto.cashCount, dto.countedCash);
    const note = dto.note?.trim() || undefined;

    await this.prisma.$transaction(async (tx) => {
      // The write takes the row lock; the condition makes a second close
      // (double click, retried request) find nothing rather than overwrite
      // the first one's snapshot.
      const locked = await tx.shift.updateMany({
        where: { id, businessId: user.businessId, closedAt: null },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) throw new BadRequestException('Shift is already closed');

      const totals = await this.totals(id, Number(shift.openingFloat), tx);
      const variance = round2(dto.countedCash - totals.expectedCash);

      // A cashier closing blind can't know the variance, and refusing their
      // count would tell them it is off -- they could then keep re-typing
      // until it was accepted. Their close always goes through; the
      // variance is there for management to read.
      const threshold = toNumber(shift.business.shiftVarianceNoteOver);
      if (
        threshold !== null &&
        Math.abs(variance) > threshold &&
        !note &&
        !isBlind(shift.business.shiftBlindClose, user)
      ) {
        throw new BadRequestException(
          `The drawer is ${variance > 0 ? 'over' : 'short'} by ${Math.abs(variance).toFixed(2)}. ` +
            'Add a note saying why before closing.',
        );
      }

      await tx.shift.update({
        where: { id },
        data: {
          closedAt: new Date(),
          countedCash: dto.countedCash,
          expectedCash: totals.expectedCash,
          variance,
          refundsAtClose: totals.refunds,
          ...(dto.cashLeft !== undefined ? { cashLeft: dto.cashLeft } : {}),
          ...(cashCount ? { cashCount } : {}),
          ...(note ? { note } : {}),
        },
      });
    }, TX_OPTS);

    // The Z report of the drawer just counted -- for the cashier at that
    // counter too, though it is no longer open and may not be their shift.
    return this.report(user.businessId, id, user, true);
  }

  /**
   * Put cash into, or take it out of, an open drawer.
   *
   * Anyone who may sell on the till may move cash on it -- a cashier on
   * their own, an owner or manager on any at their store -- and the row
   * records who did. Locked against a concurrent close for the same reason
   * `close` is.
   */
  async addMovement(user: AuthUser, shiftId: string, dto: CashMovementDto) {
    if (!REASONS[dto.type].includes(dto.reason)) {
      throw new BadRequestException(
        `${dto.reason} isn’t a reason for a ${dto.type === CashMovementType.PAY_IN ? 'pay in' : 'pay out'}`,
      );
    }
    const note = dto.note?.trim() || undefined;
    if (dto.reason === CashMovementReason.OTHER && !note) {
      throw new BadRequestException('Add a note saying what the cash was for');
    }
    await this.joinable(user, shiftId);

    const movement = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.shift.updateMany({
        where: { id: shiftId, businessId: user.businessId, closedAt: null },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) {
        throw new BadRequestException('This shift has been closed — cash can’t be moved on it now');
      }
      return tx.cashMovement.create({
        data: {
          businessId: user.businessId,
          shiftId,
          userId: user.userId,
          type: dto.type,
          reason: dto.reason,
          amount: dto.amount,
          note,
        },
        include: { user: { select: { id: true, name: true } } },
      });
    }, TX_OPTS);
    return { ...movement, amount: Number(movement.amount) };
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
          counter: { select: { id: true, name: true } },
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
   * Everything the X/Z report shows.
   *
   * Two different questions, answered from two different places:
   *
   *  - What was *sold* on this shift (gross, discounts, tax, refunds, net) is
   *    about the sales stamped with it, and `refunds` is what was handed back
   *    against those sales, whenever that happened (`Sale.refundedTotal`).
   *  - What the *drawer* should hold is about money that physically went
   *    through it, which the Payment ledger records as it happens: cash taken
   *    for sales, cash taken against credit, and cash paid out on returns
   *    processed at this till -- whichever shift the sale itself was on.
   *
   * The drawer used to be rebuilt from the sales alone, which got three things
   * wrong: a card part-payment counted as cash (the sale only says MIXED), a
   * return that cancelled credit subtracted money that never left the drawer,
   * and a return processed on a later shift came out of the wrong drawer.
   */
  private async totals(
    shiftId: string,
    openingFloat: number,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    const [sales, creditCollected, cashRefunds, movements] = await Promise.all([
      db.sale.findMany({
        where: { shiftId, status: { not: SaleStatus.HELD } },
        select: {
          discount: true,
          tax: true,
          total: true,
          refundedTotal: true,
          amountPaid: true,
          paymentMethod: true,
          userId: true,
          user: { select: { name: true } },
          payments: {
            where: { type: PaymentType.SALE },
            select: { method: true, amount: true },
          },
        },
      }),
      // Cash taken at this till against customer credit: a customer settling
      // a khata from an earlier day, so no sale on this shift explains it.
      this.payments.cashCollectedOnShift(shiftId, tx),
      this.payments.cashRefundedOnShift(shiftId, tx),
      db.cashMovement.findMany({
        where: { shiftId },
        select: { type: true, amount: true },
      }),
    ]);

    let payIns = 0;
    let payOuts = 0;
    for (const m of movements) {
      if (m.type === CashMovementType.PAY_IN) payIns += Number(m.amount);
      else payOuts += Number(m.amount);
    }

    const byTender = new Map<PaymentMethod, { count: number; amount: number }>();
    // Who rang what. On a till an owner has joined, the drawer's variance is
    // the cashier's to answer for, so the report says whose sales are in it.
    const byUser = new Map<string, { name: string; count: number; amount: number }>();
    let gross = 0;
    let discounts = 0;
    let tax = 0;
    let refunds = 0;
    let cashIn = 0;

    for (const sale of sales) {
      gross += Number(sale.total);
      discounts += Number(sale.discount);
      tax += Number(sale.tax);
      refunds += Number(sale.refundedTotal);
      const t = byTender.get(sale.paymentMethod) ?? { count: 0, amount: 0 };
      t.count += 1;
      t.amount += Number(sale.total);
      byTender.set(sale.paymentMethod, t);
      const who = byUser.get(sale.userId ?? '') ?? {
        name: sale.user?.name ?? 'Unknown',
        count: 0,
        amount: 0,
      };
      who.count += 1;
      who.amount += Number(sale.total);
      byUser.set(sale.userId ?? '', who);

      if (sale.payments.length) {
        // What was actually handed over, in the tender it was handed over in.
        for (const p of sale.payments) {
          if (CASH_TENDERS.includes(p.method)) cashIn += Number(p.amount);
        }
      } else if (CASH_TENDERS.includes(sale.paymentMethod)) {
        // A sale from before the ledger existed has no payment row, so fall
        // back to what the sale says was paid now -- the rule every report
        // used until then.
        cashIn += Number(sale.amountPaid);
      }
    }

    const expectedCash = round2(
      openingFloat + cashIn + creditCollected - cashRefunds + payIns - payOuts,
    );
    return {
      creditCollected,
      payIns: round2(payIns),
      payOuts: round2(payOuts),
      salesCount: sales.length,
      gross: round2(gross),
      discounts: round2(discounts),
      tax: round2(tax),
      refunds: round2(refunds),
      net: round2(gross - refunds),
      cashIn: round2(cashIn),
      cashRefunds,
      expectedCash,
      byTender: [...byTender.entries()].map(([method, v]) => ({
        method,
        count: v.count,
        amount: round2(v.amount),
      })),
      byUser: [...byUser.entries()]
        .map(([userId, v]) => ({
          userId: userId || null,
          name: v.name,
          count: v.count,
          amount: round2(v.amount),
        }))
        .sort((a, b) => b.amount - a.amount),
    };
  }
}
