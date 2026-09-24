import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentType,
  Prisma,
  PurchaseStatus,
  StockMovementType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { CreatePurchaseDto, PurchaseItemDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { ReturnPurchaseDto } from './dto/return-purchase.dto';
import { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Quantities are numeric(12,3) — keep float arithmetic on that grid. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private inventory: InventoryService,
    private payments: PaymentsService,
  ) {}

  async create(businessId: string, dto: CreatePurchaseDto, userId?: string) {
    // Forms send "" for "no supplier selected" -- treat that the same as
    // omitted rather than letting it hit the FK constraint as a bad id.
    if (dto.supplierId === '') dto.supplierId = undefined;
    await this.assertStore(businessId, dto.storeId);
    if (dto.supplierId) await this.assertSupplier(businessId, dto.supplierId);

    // Validate all products belong to this business
    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, businessId },
    });
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    const subtotal = round2(
      dto.items.reduce((sum, i) => sum + i.quantity * i.costPrice, 0),
    );
    const total = subtotal;
    const receiveNow = dto.receiveNow !== false;
    // Goods received now are paid in full by default; pass a smaller
    // amountPaid to buy on credit. A draft is an order not yet delivered, so
    // it defaults to nothing paid -- defaulting it to the full total booked a
    // supplier payment for money that had not changed hands.
    const amountPaid = Math.min(
      Math.max(dto.amountPaid ?? (receiveNow ? total : 0), 0),
      total,
    );

    // Serials only make sense for goods actually arriving; a draft order
    // captures them later, on POST /purchases/:id/receive.
    if (!receiveNow) {
      if (dto.items.some((i) => i.serials?.length)) {
        throw new BadRequestException(
          'Serial numbers are captured when the purchase is received',
        );
      }
    } else {
      for (const i of dto.items) {
        InventoryService.checkSerials(
          productMap.get(i.productId)!,
          i.quantity,
          i.serials,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.create({
        data: {
          businessId,
          storeId: dto.storeId,
          supplierId: dto.supplierId,
          reference: dto.reference,
          note: dto.note,
          status: receiveNow ? PurchaseStatus.RECEIVED : PurchaseStatus.DRAFT,
          subtotal,
          tax: 0,
          total,
          amountPaid,
          receivedAt: receiveNow ? new Date() : null,
          items: {
            create: dto.items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              costPrice: i.costPrice,
              batchNumber: i.batchNumber,
              expiryDate: i.expiryDate ? new Date(i.expiryDate) : null,
            })),
          },
        },
        include: { items: true },
      });

      if (receiveNow) {
        await this.receiveItems(tx, businessId, dto.storeId, purchase.id, dto, productMap);
      }

      // Paid in full by default, so most purchases hand money over the moment
      // they are entered. That is a supplier payment like any other, and
      // leaving it out of the ledger would make every such invoice look
      // unpaid when the supplier's history is added up.
      if (amountPaid > 0) {
        await this.payments.record(
          {
            businessId,
            type: PaymentType.SUPPLIER_PAYMENT,
            amount: amountPaid,
            method: PaymentMethod.CASH,
            supplierId: dto.supplierId ?? null,
            purchaseId: purchase.id,
            storeId: dto.storeId,
            userId: userId ?? null,
          },
          tx,
        );
      }
      return purchase;
    }, TX_OPTS);
  }

  /**
   * Edit an existing purchase. For a RECEIVED purchase this reverses the old
   * stock, swaps the line items, then re-applies the new stock — all in one
   * transaction. Editing is blocked if some of the original stock has already
   * been sold/moved (the reversal would drive stock negative).
   */
  async update(
    businessId: string,
    id: string,
    dto: UpdatePurchaseDto,
    userId?: string,
  ) {
    const existing = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: { items: true },
    });
    if (!existing) throw new NotFoundException('Purchase not found');
    if (existing.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('A cancelled purchase cannot be edited');
    }
    // Editing reverses the original lines, which no longer match what is on
    // the shelf once part of them has gone back to the supplier.
    if (existing.items.some((i) => Number(i.returnedQty) > 0)) {
      throw new BadRequestException(
        'A purchase with a supplier return cannot be edited',
      );
    }
    // ponytail: editing rebuilds the lines, which would orphan the units this
    // purchase booked in (some may already be sold). Blocked rather than
    // reconciled — return to the supplier or adjust instead. Revisit if shops
    // start editing serialised purchases often.
    const serialCount = await this.prisma.serial.count({
      where: { purchaseId: id },
    });
    if (serialCount > 0) {
      throw new BadRequestException(
        'A purchase with serial numbers cannot be edited — return the units to the supplier instead',
      );
    }

    const items: PurchaseItemDto[] = dto.items ?? existing.items.map((i) => ({
      productId: i.productId,
      quantity: Number(i.quantity),
      costPrice: Number(i.costPrice),
      batchNumber: i.batchNumber ?? undefined,
      expiryDate: i.expiryDate ? i.expiryDate.toISOString() : undefined,
    }));
    if (!items.length) {
      throw new BadRequestException('A purchase needs at least one item');
    }

    if (dto.supplierId === '') dto.supplierId = undefined;
    const newStoreId = dto.storeId ?? existing.storeId;
    await this.assertStore(businessId, newStoreId);
    if (dto.supplierId) await this.assertSupplier(businessId, dto.supplierId);

    const productIds = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, businessId },
    });
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }

    const subtotal = round2(
      items.reduce((sum, i) => sum + i.quantity * i.costPrice, 0),
    );
    const total = subtotal;
    const amountPaid = Math.min(
      Math.max(dto.amountPaid ?? Number(existing.amountPaid), 0),
      total,
    );
    const wasReceived = existing.status === PurchaseStatus.RECEIVED;

    return this.prisma.$transaction(async (tx) => {
      // 1. Back out the stock (and matching batch) this purchase had added.
      if (wasReceived) {
        for (const item of existing.items) {
          try {
            await this.inventory.applyMovement(tx, {
              businessId,
              storeId: existing.storeId,
              productId: item.productId,
              type: StockMovementType.PURCHASE,
              quantity: -Number(item.quantity),
              reference: existing.id,
              note: 'Purchase edited — original stock reversed',
            });
            await this.reverseBatchIfNeeded(tx, existing.storeId, item);
          } catch (err) {
            // Only an insufficient-stock rejection means "already sold or
            // moved". A bare `catch {}` here relabelled *every* failure --
            // a dropped connection, a constraint violation -- as that, which
            // sent people hunting for stock movements that never happened.
            if (!(err instanceof BadRequestException)) throw err;
            throw new BadRequestException(
              'Cannot edit: some of this purchase’s stock has already been sold or moved',
            );
          }
        }
      }

      // 2. Replace the line items and recompute totals.
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
      await tx.purchase.update({
        where: { id },
        data: {
          storeId: newStoreId,
          supplierId: dto.supplierId ?? null,
          reference: dto.reference ?? null,
          note: dto.note ?? null,
          subtotal,
          tax: 0,
          total,
          amountPaid,
          items: {
            create: items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              costPrice: i.costPrice,
              batchNumber: i.batchNumber,
              expiryDate: i.expiryDate ? new Date(i.expiryDate) : null,
            })),
          },
        },
      });

      // An edit can change what was paid -- directly, or because a smaller
      // total clamps it down. Record the difference, so the supplier's
      // payments still add up to what their invoices say was paid.
      const paidDelta = round2(amountPaid - Number(existing.amountPaid));
      if (paidDelta !== 0) {
        await this.payments.record(
          {
            businessId,
            type:
              paidDelta > 0
                ? PaymentType.SUPPLIER_PAYMENT
                : PaymentType.SUPPLIER_REFUND,
            amount: Math.abs(paidDelta),
            method: PaymentMethod.CASH,
            supplierId: dto.supplierId ?? null,
            purchaseId: id,
            storeId: newStoreId,
            userId: userId ?? null,
            note: 'Purchase edited',
          },
          tx,
        );
      }

      // 3. Re-apply stock for the new lines (only if already received).
      if (wasReceived) {
        for (const item of items) {
          await this.inventory.applyMovement(tx, {
            businessId,
            storeId: newStoreId,
            productId: item.productId,
            type: StockMovementType.PURCHASE,
            quantity: item.quantity,
            reference: id,
          });
          await this.createBatchIfNeeded(tx, businessId, newStoreId, {
            productId: item.productId,
            quantity: item.quantity,
            costPrice: new Prisma.Decimal(item.costPrice),
            batchNumber: item.batchNumber ?? null,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
          });
          await tx.product.update({
            where: { id: item.productId },
            data: { costPrice: item.costPrice },
          });
        }
      }

      const updated = await tx.purchase.findFirstOrThrow({
        where: { id },
        include: { items: true },
      });
      return {
        ...updated,
        outstanding: round2(Number(updated.total) - Number(updated.amountPaid)),
      };
    }, TX_OPTS);
  }

  /**
   * Receive a draft purchase: add stock, create batches, update cost. Lines
   * for serialised products must carry one scanned serial/IMEI per unit.
   */
  async receive(businessId: string, id: string, dto: ReceivePurchaseDto = {}) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: { items: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    if (purchase.status === PurchaseStatus.RECEIVED) {
      throw new BadRequestException('Purchase already received');
    }
    if (purchase.status === PurchaseStatus.CANCELLED) {
      throw new BadRequestException('Purchase was cancelled');
    }

    // Validate every line's serials before any stock moves.
    const products = await this.prisma.product.findMany({
      where: { id: { in: purchase.items.map((i) => i.productId) }, businessId },
      select: { id: true, name: true, trackSerials: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const scanned = new Map(
      (dto.items ?? []).map((i) => [i.purchaseItemId, i.serials]),
    );
    const serialsByItem = new Map(
      purchase.items.map((item) => [
        item.id,
        InventoryService.checkSerials(
          productMap.get(item.productId)!,
          Number(item.quantity),
          scanned.get(item.id),
        ),
      ]),
    );

    return this.prisma.$transaction(async (tx) => {
      // Atomically claim the DRAFT -> RECEIVED transition before touching
      // stock. If another request already received this purchase (double
      // click, retried request), this matches zero rows and we bail out
      // before adding stock a second time -- the earlier findFirst check
      // above ran outside the transaction and can't be trusted alone.
      const claimed = await tx.purchase.updateMany({
        where: { id, businessId, status: purchase.status },
        data: { status: PurchaseStatus.RECEIVED, receivedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new BadRequestException('Purchase already received');
      }

      // One batched stock write for the whole delivery, the way checkout,
      // returns and receive-on-create already do it. This loop previously made
      // four sequential round trips per line inside a transaction holding row
      // locks the whole way -- a 50-line purchase cost ~200 of them, against a
      // database that is not co-located with the app.
      await this.inventory.applyMovementsBatch(
        tx,
        purchase.items.map((item) => ({
          businessId,
          storeId: purchase.storeId,
          productId: item.productId,
          type: StockMovementType.PURCHASE,
          quantity: Number(item.quantity),
          reference: purchase.id,
        })),
      );

      // Cost snapshots: one updateMany per *distinct* cost rather than one
      // update per line.
      //
      // The old loop wrote costPrice per line in order, so when a purchase
      // listed the same product twice at different costs the last line won.
      // Grouping by cost alone would lose that -- the two updateMany calls
      // could land in either order. So collapse to one cost per product first,
      // keeping the last line's, and group what remains.
      const lastCostByProduct = new Map<string, Prisma.Decimal>();
      for (const item of purchase.items) {
        lastCostByProduct.set(item.productId, item.costPrice);
      }
      const productsByCost = new Map<string, string[]>();
      for (const [productId, cost] of lastCostByProduct) {
        const key = String(cost);
        productsByCost.set(key, [...(productsByCost.get(key) ?? []), productId]);
      }
      for (const [cost, ids] of productsByCost) {
        await tx.product.updateMany({
          where: { id: { in: ids } },
          data: { costPrice: cost },
        });
      }

      // Batches and serials stay per line: each carries per-item logic
      // (natural-key batch merge, serial reconciliation) that does not reduce
      // to a single statement. A throw anywhere still rolls the whole receive
      // back.
      for (const item of purchase.items) {
        await this.createBatchIfNeeded(tx, businessId, purchase.storeId, item);
        await this.inventory.receiveSerials(tx, {
          businessId,
          storeId: purchase.storeId,
          productId: item.productId,
          purchaseId: purchase.id,
          serials: serialsByItem.get(item.id) ?? [],
        });
      }
      return tx.purchase.findFirstOrThrow({
        where: { id },
        include: { items: true },
      });
    }, TX_OPTS);
  }

  /**
   * Send goods back to the supplier (debit note). Mirrors the sales return:
   * per-line returnedQty, partial returns allowed, stock out through the same
   * choke point (as RETURN_OUT), and the purchase's own total shrinks so the
   * payable on the Credit page drops by the same amount.
   *
   * Money already paid is left alone, so returning goods on a fully-paid
   * purchase leaves `outstanding` negative — that is the supplier owing a
   * refund, which is exactly what a debit note means.
   */
  async returnItems(
    businessId: string,
    userId: string,
    id: string,
    dto: ReturnPurchaseDto,
  ) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: { items: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    if (purchase.status !== PurchaseStatus.RECEIVED) {
      throw new BadRequestException(
        'Only a received purchase can be returned to the supplier',
      );
    }

    const itemMap = new Map(purchase.items.map((it) => [it.id, it]));
    const serialised = new Set(
      (
        await this.prisma.product.findMany({
          where: {
            id: { in: purchase.items.map((i) => i.productId) },
            businessId,
            trackSerials: true,
          },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    let value = 0;
    for (const r of dto.items) {
      const item = itemMap.get(r.purchaseItemId);
      if (!item) throw new BadRequestException('Invalid purchase item');
      const returnable = round3(
        Number(item.quantity) - Number(item.returnedQty),
      );
      if (r.quantity > returnable) {
        throw new BadRequestException(
          `Cannot return ${r.quantity} of this line (only ${returnable} left)`,
        );
      }
      value += Number(item.costPrice) * r.quantity;
    }
    value = round2(value);
    const newSubtotal = round2(Number(purchase.subtotal) - value);
    const newTotal = round2(Number(purchase.total) - value);
    // Returning goods shrinks what is owed, but the money already handed over
    // doesn't shrink with it. Without clamping, a return against a fully-paid
    // purchase left amountPaid above total and `outstanding` went negative --
    // a nonsense balance that reads as "the supplier owes us" everywhere it
    // is displayed. Clamp it, and report the excess as what it is: money the
    // supplier now owes back, which is settled outside this record.
    const paidBefore = Number(purchase.amountPaid);
    const newAmountPaid = round2(Math.min(paidBefore, Math.max(newTotal, 0)));
    const refundDueFromSupplier = round2(paidBefore - newAmountPaid);

    return this.prisma.$transaction(async (tx) => {
      // Guarded: stock cannot go negative, so goods already sold on cannot be
      // returned to the supplier from an empty shelf.
      await this.inventory.applyMovementsBatch(
        tx,
        dto.items.map((r) => {
          const item = itemMap.get(r.purchaseItemId)!;
          return {
            businessId,
            storeId: purchase.storeId,
            productId: item.productId,
            type: StockMovementType.RETURN_OUT,
            quantity: -r.quantity,
            userId,
            note: dto.note ?? 'Returned to supplier',
            reference: purchase.id,
          };
        }),
      );

      for (const r of dto.items) {
        const item = itemMap.get(r.purchaseItemId)!;
        // Guarded increment — same reasoning as the sale-return path: the
        // returnable check above ran against a snapshot read before this
        // transaction, so two concurrent returns of the same line would both
        // pass it and over-return the line. The `<= quantity` test here is
        // evaluated against the locked row, so the second one matches nothing.
        const delta = String(round3(r.quantity));
        const bumped = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "PurchaseItem"
          SET "returnedQty" = "returnedQty" + ${delta}::numeric
          WHERE id = ${item.id}
            AND "returnedQty" + ${delta}::numeric <= quantity
          RETURNING id
        `;
        if (bumped.length === 0) {
          throw new BadRequestException(
            'Cannot return this line — it was returned by someone else just now',
          );
        }
        await this.reverseBatchIfNeeded(tx, purchase.storeId, {
          productId: item.productId,
          quantity: r.quantity,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
        });
        if (serialised.has(item.productId)) {
          await this.inventory.returnSerialsToSupplier(tx, {
            businessId,
            productId: item.productId,
            purchaseId: purchase.id,
            quantity: r.quantity,
            serials: r.serials,
          });
        }
      }

      // Clamping amountPaid down to the new total is money the supplier now
      // owes back. It is logged as a supplier refund when the return is made,
      // since that is when the paid-to-date figure drops; the refund itself
      // is settled outside the app, which the note says.
      if (refundDueFromSupplier > 0) {
        await this.payments.record(
          {
            businessId,
            type: PaymentType.SUPPLIER_REFUND,
            amount: refundDueFromSupplier,
            method: PaymentMethod.CASH,
            supplierId: purchase.supplierId,
            purchaseId: purchase.id,
            storeId: purchase.storeId,
            userId,
            note: 'Refund due on goods returned',
          },
          tx,
        );
      }

      const updated = await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          subtotal: newSubtotal,
          total: newTotal,
          amountPaid: newAmountPaid,
          note: dto.note ?? purchase.note,
        },
        include: { items: true },
      });
      return {
        purchase: {
          ...updated,
          outstanding: round2(
            Number(updated.total) - Number(updated.amountPaid),
          ),
        },
        returnedValue: value,
        refundDueFromSupplier,
      };
    }, TX_OPTS);
  }

  /**
   * Pay a supplier against a purchase invoice.
   *
   * The balance move and its ledger row commit together, so "what do we still
   * owe this supplier" and "what have we actually paid them" can never tell
   * different stories.
   */
  async recordPayment(
    businessId: string,
    id: string,
    amount: number,
    context: { method?: PaymentMethod; userId?: string; note?: string } = {},
  ) {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');

    return this.prisma.$transaction(async (tx) => {
      // Atomic guarded increment: the outstanding check and the write happen
      // in one statement against the row's live value, so two concurrent
      // payments can't both pass a stale check and push amountPaid past total.
      const claimed = await tx.$executeRaw`
        UPDATE "Purchase"
        SET "amountPaid" = "amountPaid" + ${amount}
        WHERE id = ${id} AND "businessId" = ${businessId}
          AND "amountPaid" + ${amount} <= total + 0.001
      `;
      if (claimed === 0) {
        const outstanding = round2(
          Number(purchase.total) - Number(purchase.amountPaid),
        );
        throw new BadRequestException(
          `Payment exceeds the outstanding ${outstanding}`,
        );
      }

      await this.payments.record(
        {
          businessId,
          type: PaymentType.SUPPLIER_PAYMENT,
          amount,
          method: context.method ?? PaymentMethod.CASH,
          supplierId: purchase.supplierId,
          purchaseId: id,
          storeId: purchase.storeId,
          // Deliberately no shiftId: paying a supplier is not a till
          // transaction, and booking it to a drawer would make that drawer
          // expect to be short by the payment at close.
          userId: context.userId ?? null,
          note: context.note ?? null,
        },
        tx,
      );

      const updated = await tx.purchase.findUniqueOrThrow({ where: { id } });
      return {
        ...updated,
        outstanding: round2(Number(updated.total) - Number(updated.amountPaid)),
      };
    });
  }

  async findAll(businessId: string, q: PaginationDto) {
    const where: Prisma.PurchaseWhereInput = { businessId };
    const [data, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        include: {
          supplier: { select: { id: true, name: true } },
          store: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.purchase.count({ where }),
    ]);
    const mapped = data.map((p) => ({
      ...p,
      outstanding: round2(Number(p.total) - Number(p.amountPaid)),
    }));
    return paginate(mapped, total, q.page, q.limit);
  }

  async findOne(businessId: string, id: string) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: {
        supplier: true,
        store: { select: { id: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true } } } },
      },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    return {
      ...purchase,
      outstanding: round2(Number(purchase.total) - Number(purchase.amountPaid)),
    };
  }

  /**
   * Items at or below their reorder level, grouped into one draft order per
   * (store, supplier). Supplier is the one on that product's most recent
   * purchase -- products never bought land in the "no supplier" group. Cost is
   * the last price paid, falling back to the product's cost price.
   */
  async reorderSuggestions(businessId: string, storeId?: string) {
    const low = await this.inventory.lowStock(businessId, storeId);
    if (!low.length) return [];

    // Newest first, so the first row seen for a product is its last purchase.
    const history = await this.prisma.purchaseItem.findMany({
      where: {
        productId: { in: low.map((it) => it.productId) },
        purchase: { businessId },
      },
      select: {
        productId: true,
        costPrice: true,
        purchase: {
          select: {
            createdAt: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { purchase: { createdAt: 'desc' } },
    });
    const last = new Map<string, (typeof history)[number]>();
    for (const h of history) if (!last.has(h.productId)) last.set(h.productId, h);

    type Group = {
      storeId: string;
      storeName: string;
      supplierId: string | null;
      supplierName: string | null;
      items: {
        productId: string;
        name: string;
        sku: string | null;
        unit: string;
        onHand: number;
        reorderLevel: number;
        quantity: number;
        costPrice: number;
        lastPurchasedAt: Date | null;
      }[];
      total: number;
    };
    const groups = new Map<string, Group>();

    for (const it of low) {
      const prev = last.get(it.productId);
      const supplier = prev?.purchase.supplier ?? null;
      const key = `${it.storeId}|${supplier?.id ?? ''}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          storeId: it.storeId,
          storeName: it.store.name,
          supplierId: supplier?.id ?? null,
          supplierName: supplier?.name ?? null,
          items: [],
          total: 0,
        };
        groups.set(key, g);
      }
      const onHand = Number(it.quantity);
      // ponytail: par level = 2x the reorder point. Swap for demand-based
      // forecasting if turnover varies a lot between products.
      const quantity = round3(
        Math.max(it.effectiveReorderLevel * 2 - onHand, 1),
      );
      const costPrice = round2(
        Number(prev?.costPrice ?? it.product.costPrice),
      );
      g.items.push({
        productId: it.productId,
        name: it.product.name,
        sku: it.product.sku,
        unit: it.product.unit,
        onHand,
        reorderLevel: it.effectiveReorderLevel,
        quantity,
        costPrice,
        lastPurchasedAt: prev?.purchase.createdAt ?? null,
      });
      g.total = round2(g.total + quantity * costPrice);
    }
    return [...groups.values()];
  }

  /**
   * Turn the suggestions above into real DRAFT purchases (nothing is received
   * and nothing is paid). Narrow with storeId/supplierId to draft just one.
   */
  async createReorderDrafts(
    businessId: string,
    opts: { storeId?: string; supplierId?: string },
  ) {
    const groups = (await this.reorderSuggestions(businessId, opts.storeId))
      .filter((g) => !opts.supplierId || g.supplierId === opts.supplierId);
    if (!groups.length) {
      throw new BadRequestException('Nothing is below its reorder level');
    }
    const drafts: Awaited<ReturnType<typeof this.create>>[] = [];
    for (const g of groups) {
      drafts.push(
        await this.create(businessId, {
          storeId: g.storeId,
          supplierId: g.supplierId ?? undefined,
          note: 'Auto-generated from low stock',
          receiveNow: false,
          amountPaid: 0,
          items: g.items.map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            costPrice: i.costPrice,
          })),
        }),
      );
    }
    return drafts;
  }

  // ---- helpers ----

  private async receiveItems(
    tx: Prisma.TransactionClient,
    businessId: string,
    storeId: string,
    purchaseId: string,
    dto: CreatePurchaseDto,
    _productMap: Map<string, { id: string }>,
  ) {
    // One batched stock write for the whole delivery rather than a
    // read + upsert + insert per line, the same way checkout and returns
    // already do it -- an N-line purchase cost 5N round trips before this,
    // and the DB is not co-located with the app. See applyMovementsBatch.
    await this.inventory.applyMovementsBatch(
      tx,
      dto.items.map((item) => ({
        businessId,
        storeId,
        productId: item.productId,
        type: StockMovementType.PURCHASE,
        quantity: item.quantity,
        reference: purchaseId,
      })),
    );

    // Batches, serials and cost price stay per line: each carries per-item
    // logic (natural-key batch merge, serial reconciliation) that doesn't
    // reduce to a single statement. Order is independent of the stock write
    // above, and a throw anywhere still rolls the whole purchase back.
    for (const item of dto.items) {
      await this.createBatchIfNeeded(tx, businessId, storeId, {
        productId: item.productId,
        quantity: item.quantity,
        costPrice: new Prisma.Decimal(item.costPrice),
        batchNumber: item.batchNumber ?? null,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
      });
      await this.inventory.receiveSerials(tx, {
        businessId,
        storeId,
        productId: item.productId,
        purchaseId,
        serials: item.serials ?? [],
      });
      await tx.product.update({
        where: { id: item.productId },
        data: { costPrice: item.costPrice },
      });
    }
  }

  private async createBatchIfNeeded(
    tx: Prisma.TransactionClient,
    businessId: string,
    storeId: string,
    item: {
      productId: string;
      quantity: Prisma.Decimal | number;
      costPrice: Prisma.Decimal;
      batchNumber: string | null;
      expiryDate: Date | null;
    },
  ) {
    if (!item.batchNumber && !item.expiryDate) return;
    // Merge into an existing batch with the same natural key (store,
    // product, batch number, expiry) instead of always inserting a new
    // row -- otherwise receiving the same batch twice (a second purchase,
    // or a purchase edit that re-applies its lines) forks into duplicate
    // Batch rows that double-count "expiring soon" and desync from the
    // real StockItem total.
    const existing = await tx.batch.findFirst({
      where: {
        storeId,
        productId: item.productId,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
      },
    });
    if (existing) {
      await tx.batch.update({
        where: { id: existing.id },
        data: { quantity: { increment: item.quantity }, costPrice: item.costPrice },
      });
    } else {
      await tx.batch.create({
        data: {
          businessId,
          storeId,
          productId: item.productId,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate,
          quantity: item.quantity,
          costPrice: item.costPrice,
        },
      });
    }
  }

  /**
   * Mirror of createBatchIfNeeded for reversing a purchase edit: decrements
   * the matching batch instead of leaving a stale row behind. Throws (same
   * as the stock reversal above) if some of that batch has already been
   * sold/moved, since undoing it would drive the batch negative.
   */
  private async reverseBatchIfNeeded(
    tx: Prisma.TransactionClient,
    storeId: string,
    item: {
      productId: string;
      quantity: Prisma.Decimal | number;
      batchNumber: string | null;
      expiryDate: Date | null;
    },
  ) {
    if (!item.batchNumber && !item.expiryDate) return;
    const existing = await tx.batch.findFirst({
      where: {
        storeId,
        productId: item.productId,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
      },
    });
    if (!existing) return; // nothing tracked to reverse
    if (Number(existing.quantity) < Number(item.quantity)) {
      throw new BadRequestException('That batch stock has already been sold or moved');
    }
    await tx.batch.update({
      where: { id: existing.id },
      data: { quantity: { decrement: item.quantity } },
    });
  }

  private async assertStore(businessId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId },
    });
    if (!store) throw new BadRequestException('Invalid store');
  }

  private async assertSupplier(businessId: string, supplierId: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, businessId },
    });
    if (!supplier) throw new BadRequestException('Invalid supplier');
  }
}
