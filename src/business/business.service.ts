import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentMethod, SaleStatus } from '@prisma/client';
import { SETTLE_METHODS } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBusinessDto } from './business.controller';

/** What every shop starts with (the column default). */
const DEFAULT_TENDERS: PaymentMethod[] = [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.MOBILE];

/**
 * The tenders as stored: always cash -- it is the counter default, and what a
 * part-paid sale falls back to -- and in the pickers' order, not the click order.
 */
export const acceptedTenders = (picked: PaymentMethod[]) =>
  SETTLE_METHODS.filter((m) => m === PaymentMethod.CASH || picked.includes(m));

@Injectable()
export class BusinessService {
  constructor(private prisma: PrismaService) {}

  async get(businessId: string) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) throw new NotFoundException('Business not found');
    return business;
  }

  /**
   * A new shop's first steps, each true once done: something to sell, stock
   * of it, someone to help, a sale through the till, and a look at how
   * customers can pay (any change from the tenders every shop starts with).
   * One indexed row lookup each, so the Dashboard can ask on every visit.
   */
  async setup(businessId: string) {
    const [business, product, stock, staff, sale] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: businessId }, select: { acceptedTenders: true } }),
      this.prisma.product.findFirst({ where: { businessId }, select: { id: true } }),
      this.prisma.stockItem.findFirst({ where: { businessId, quantity: { gt: 0 } }, select: { id: true } }),
      this.prisma.user.count({ where: { businessId } }),
      this.prisma.sale.findFirst({ where: { businessId, status: { not: SaleStatus.HELD } }, select: { id: true } }),
    ]);
    if (!business) throw new NotFoundException('Business not found');
    const tenders = business.acceptedTenders;
    return {
      products: !!product,
      stock: !!stock,
      paymentMethods: !(tenders.length === 3 && DEFAULT_TENDERS.every((m) => tenders.includes(m))),
      staff: staff > 1,
      sale: !!sale,
    };
  }

  async update(businessId: string, dto: UpdateBusinessDto) {
    await this.get(businessId);
    return this.prisma.business.update({
      where: { id: businessId },
      data: {
        ...dto,
        ...(dto.currency ? { currency: dto.currency.toUpperCase() } : {}),
        ...(dto.acceptedTenders ? { acceptedTenders: acceptedTenders(dto.acceptedTenders) } : {}),
      },
    });
  }

  /**
   * Full export of a tenant's data, streamed as NDJSON (owner download).
   * Passwords are never included.
   *
   * This used to be thirteen `findMany()` calls with no `take:` between them,
   * awaited together and serialised into one JSON object: the whole tenant in
   * the API process's heap, twice over once `JSON.stringify` ran, and a
   * response the client had to buffer whole before it could write a byte of
   * it. A shop with a few years of sales behind it is the one that most needs
   * a backup and the one most likely to take the process down asking for it.
   *
   * Now each table is walked in pages and each row is written as its own line
   * as soon as it is read, so peak memory is one page rather than one tenant,
   * and the download starts immediately. One line per row, each tagged with
   * the table it came from:
   *
   *     {"table":"product","row":{...}}
   *
   * NDJSON rather than a JSON array because an array has to be closed: a
   * stream that dies halfway through leaves a file no parser will touch,
   * whereas a truncated NDJSON file is every row up to the failure, each one
   * still readable on its own. The `_meta` first line carries the format
   * version so a reader can tell what it is holding.
   */
  async *exportNdjson(businessId: string): AsyncGenerator<string> {
    const where = { businessId };
    const line = (table: string, row: unknown) =>
      `${JSON.stringify({ table, row })}\n`;

    yield line('_meta', {
      exportedAt: new Date().toISOString(),
      businessId,
      format: 'ndjson',
      version: 1,
    });

    // Singleton: one row, no paging.
    yield line('business', await this.get(businessId));

    // Users never carry their password hash out of the system.
    yield* this.pageTable('user', (args) =>
      this.prisma.user.findMany({
        ...args,
        where,
        select: {
          id: true, email: true, name: true, role: true,
          storeId: true, counterId: true, isActive: true, emailVerified: true, createdAt: true,
        },
      }),
    );

    yield* this.pageTable('store', (a) => this.prisma.store.findMany({ ...a, where }));
    // The drawers: which counter each shift counted, and each cashier works.
    yield* this.pageTable('counter', (a) => this.prisma.counter.findMany({ ...a, where }));
    yield* this.pageTable('category', (a) => this.prisma.category.findMany({ ...a, where }));
    yield* this.pageTable('tax', (a) => this.prisma.tax.findMany({ ...a, where }));
    yield* this.pageTable('product', (a) =>
      this.prisma.product.findMany({
        ...a,
        where,
        include: { categories: { select: { id: true, name: true } } },
      }),
    );
    yield* this.pageTable('supplier', (a) => this.prisma.supplier.findMany({ ...a, where }));
    yield* this.pageTable('customer', (a) => this.prisma.customer.findMany({ ...a, where }));
    yield* this.pageTable('purchase', (a) =>
      this.prisma.purchase.findMany({ ...a, where, include: { items: true } }),
    );
    yield* this.pageTable('sale', (a) =>
      this.prisma.sale.findMany({ ...a, where, include: { items: true } }),
    );
    yield* this.pageTable('stockItem', (a) => this.prisma.stockItem.findMany({ ...a, where }));
    yield* this.pageTable('stockMovement', (a) =>
      this.prisma.stockMovement.findMany({ ...a, where }),
    );
    yield* this.pageTable('batch', (a) => this.prisma.batch.findMany({ ...a, where }));
    // The records a shop's books and warranties rest on. The export stopped
    // at stock, so a "full" download -- the backup an owner keeps, and what a
    // shop leaving the platform is handed -- had no payment history, no till
    // reports and no serial numbers.
    yield* this.pageTable('serial', (a) => this.prisma.serial.findMany({ ...a, where }));
    yield* this.pageTable('shift', (a) => this.prisma.shift.findMany({ ...a, where }));
    yield* this.pageTable('cashMovement', (a) =>
      this.prisma.cashMovement.findMany({ ...a, where }),
    );
    yield* this.pageTable('payment', (a) => this.prisma.payment.findMany({ ...a, where }));
    yield* this.pageTable('auditLog', (a) => this.prisma.auditLog.findMany({ ...a, where }));
    yield* this.pageTable('supportTicket', (a) =>
      this.prisma.supportTicket.findMany({ ...a, where, include: { messages: true } }),
    );
  }

  /**
   * Walk one table in id order, a page at a time, yielding NDJSON lines.
   *
   * Keyset pagination on the primary key, not `skip`/`offset`: offset makes
   * the database count past everything it has already returned, so the last
   * page of a long table costs the most. Ordering by `id` also gives a stable
   * walk while rows are being written underneath it -- cuids ascend, so a row
   * created mid-export lands after the cursor and is simply included.
   */
  private async *pageTable<T extends { id: string }>(
    table: string,
    fetch: (args: {
      take: number;
      orderBy: { id: 'asc' };
      cursor?: { id: string };
      skip?: number;
    }) => Promise<T[]>,
    pageSize = 500,
  ): AsyncGenerator<string> {
    let cursor: string | undefined;
    for (;;) {
      const rows = await fetch({
        take: pageSize,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) yield `${JSON.stringify({ table, row })}\n`;
      if (rows.length < pageSize) return;
      cursor = rows[rows.length - 1].id;
    }
  }
}
