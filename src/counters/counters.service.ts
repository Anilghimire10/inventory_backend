import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TX_OPTS } from '../common/prisma-tx';
import { lockStoreTills } from '../common/store-lock';
import { CreateCounterDto, UpdateCounterDto } from './dto/counter.dto';

/** A counter's name, trimmed; spaces alone are no name at all. */
function counterName(raw: string) {
  const name = raw.trim();
  if (!name) throw new BadRequestException('Give the counter a name');
  return name;
}

/**
 * Counters: the cash drawers at each store. The owner sets them up before
 * assigning staff -- a cashier is assigned to exactly one and only ever opens
 * that one; an owner or manager chooses one at the POS. Never deleted, only
 * taken out of use, so old shifts keep naming the drawer they counted.
 */
@Injectable()
export class CountersService {
  constructor(private prisma: PrismaService) {}

  /**
   * A business's counters (or one store's), each with the cashiers assigned
   * to it and the shift open on it, if any -- what Settings lists, what the
   * Staff form picks from, and what an owner chooses from at the till.
   */
  async list(businessId: string, storeId?: string, includeInactive = false) {
    const counters = await this.prisma.counter.findMany({
      where: { businessId, ...(storeId ? { storeId } : {}), ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ storeId: 'asc' }, { createdAt: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        storeId: true,
        isActive: true,
        users: {
          where: { isActive: true, role: UserRole.CASHIER },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        },
        shifts: {
          where: { closedAt: null },
          select: { id: true, openedAt: true, user: { select: { id: true, name: true, role: true } } },
          take: 1,
        },
      },
    });
    return counters.map(({ users, shifts, ...c }) => ({ ...c, staff: users, openShift: shifts[0] ?? null }));
  }

  async create(businessId: string, dto: CreateCounterDto) {
    const store = await this.prisma.store.findFirst({
      where: { id: dto.storeId, businessId },
      select: { id: true, name: true, isActive: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    if (!store.isActive) throw new BadRequestException('Reopen the store before adding a counter to it');
    const name = counterName(dto.name);
    try {
      return await this.prisma.counter.create({
        data: { businessId, storeId: store.id, name },
      });
    } catch (e) {
      throw this.duplicate(e, store.name, name);
    }
  }

  async update(businessId: string, id: string, dto: UpdateCounterDto) {
    const counter = await this.prisma.counter.findFirst({
      where: { id, businessId },
      include: { store: { select: { name: true } } },
    });
    if (!counter) throw new NotFoundException('Counter not found');

    const name = dto.name !== undefined ? counterName(dto.name) : undefined;

    try {
      // Under the lock opening a shift at this store takes: otherwise a till
      // opened on this counter between the checks below and the update left
      // a counter out of use with a shift open on it.
      return await this.prisma.$transaction(async (tx) => {
        await lockStoreTills(tx, counter.storeId);
        if (dto.isActive === false && counter.isActive) {
          const [open, assigned, others] = await Promise.all([
            tx.shift.findFirst({
              where: { counterId: id, closedAt: null },
              select: { user: { select: { name: true } } },
            }),
            tx.user.findMany({
              where: { counterId: id, isActive: true, role: UserRole.CASHIER },
              select: { name: true },
              take: 3,
            }),
            tx.counter.count({ where: { storeId: counter.storeId, isActive: true, NOT: { id } } }),
          ]);
          // Its drawer is being counted right now: closing that shift first
          // is the only way the cash in it gets reconciled.
          if (open) {
            throw new ConflictException(`${counter.name} has ${open.user.name}’s shift open. Close it first.`);
          }
          // A cashier only ever opens their own counter, so taking it away
          // would leave them unable to sell.
          if (assigned.length) {
            throw new ConflictException(
              `${assigned.map((u) => u.name).join(', ')} ${assigned.length === 1 ? 'is' : 'are'} assigned to ${counter.name}. ` +
                'Move them to another counter in Staff first.',
            );
          }
          if (others === 0) throw new ConflictException('A store needs at least one counter in use');
        }
        return tx.counter.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
      }, TX_OPTS);
    } catch (e) {
      throw this.duplicate(e, counter.store.name, name ?? counter.name);
    }
  }

  private duplicate(e: unknown, storeName: string, name: string) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException(`${storeName} already has a counter called “${name}”`);
    }
    return e;
  }
}
