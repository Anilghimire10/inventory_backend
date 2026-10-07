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
import { InventoryService, convertToBatches } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { CreatePurchaseDto, PurchaseItemDto } from './dto/create-purchase.dto';
import { UpdatePurchaseDto } from './dto/update-purchase.dto';
import { ReturnPurchaseDto } from './dto/return-purchase.dto';
import { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';
import { TX_OPTS } from '../common/prisma-tx';
import { AuthUser } from '../common/types/auth-user';
import { assertOwnStore } from '../common/store-scope';

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Quantities are numeric(12,3) — keep float arithmetic on that grid. */
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * What a purchase comes to: the goods at cost (before VAT), the VAT the
 * supplier charged on top of each line, and the two together -- the amount
 * owed. The VAT is input tax: the Tax report sets it against the VAT
 * collected on sales.
 */
export function purchaseTotals(items: { quantity: number; costPrice: number; taxRate?: number | null }[]) {
  let subtotal = 0;
  let tax = 0;
  for (const i of items) {
    const net = i.quantity * i.costPrice;
    subtotal += net;
    tax += (net * Number(i.taxRate ?? 0)) / 100;
  }
  subtotal = round2(subtotal);
  tax = round2(tax);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

/**
 * A product's cost after stock moves in (or, with a negative quantity, back
 * out) at the given costs: the weighted average of what was on the shelf at
 * the old cost and what moved. Taking the last price paid instead mis-stated
 * the profit on every unit still on the shelf from an earlier delivery.
 *
 * Nothing on the shelf, or no cost on file yet: the moves alone set it. A
 * result that can't be a cost (everything moved back out, or a negative
 * value from stock already below zero) falls back to the latest price in.
 */
export function weightedCost(
  onHand: number,
  current: number,
  moves: { quantity: number; costPrice: number }[],
): number {
  const incoming = moves.filter((m) => m.quantity > 0);
  const fallback = incoming.length ? incoming[incoming.length - 1].costPrice : current;
  const base = current > 0 ? Math.max(onHand, 0) : 0;
  const qty = base + moves.reduce((n, m) => n + m.quantity, 0);
  const value = base * current + moves.reduce((n, m) => n + m.quantity * m.costPrice, 0);
  if (qty <= 0) return fallback;
  const avg = value / qty;
  return avg > 0 ? round2(avg) : fallback;
}

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

    const { subtotal, tax, total } = purchaseTotals(dto.items);
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
          tax,
          total,
          amountPaid,
          receivedAt: receiveNow ? new Date() : null,
          items: {
            create: dto.items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              costPrice: i.costPrice,
              taxRate: i.taxRate ?? 0,
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
            method: dto.paymentMethod ?? PaymentMethod.CASH,
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
    // An edit recomputes what was paid against the new total, and a refund
    // already owed was worked out against the old one. Settle it first.
    if (Number(existing.refundDue) > 0) {
      throw new BadRequestException(
        'The supplier still owes a refund on this purchase — record it as received before editing',
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
      taxRate: Number(i.taxRate),
      batchNumber: i.batchNumber ?? undefined,
      expiryDate: i.expiryDate ? i.expiryDate.toISOString() : undefined,
    }));
    if (!items.length) {
      throw new BadRequestException('A purchase needs at least one item');
    }

    // '' is the form's "no supplier" -- an explicit clear, which a missing
    // field is not. Absent keeps the purchase's supplier.
    const supplierId = dto.supplierId === '' ? null : dto.supplierId;
    const newStoreId = dto.storeId ?? existing.storeId;
    await this.assertStore(businessId, newStoreId);
    if (supplierId) await this.assertSupplier(businessId, supplierId);

    const productIds = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, businessId },
    });
    if (products.length !== new Set(productIds).size) {
      throw new BadRequestException('One or more products are invalid');
    }
    // The lines being reversed may name products the new lines don't.
    const batched = await this.batchTracked(businessId, [
      ...productIds,
      ...existing.items.map((i) => i.productId),
    ]);

    const { subtotal, tax, total } = purchaseTotals(items);
    const paidBefore = Number(existing.amountPaid);
    const requested = Math.max(dto.amountPaid ?? paidBefore, 0);
    const amountPaid = Math.min(requested, total);
    // Money already handed over that the new, smaller total no longer covers:
    // the supplier owes it back. Only what was really paid counts -- an
    // amountPaid typed above the total is a typo to clamp, not a debt.
    const owedBack = round2(Math.max(Math.min(requested, paidBefore) - total, 0));
    const wasReceived = existing.status === PurchaseStatus.RECEIVED;

    return this.prisma.$transaction(async (tx) => {
      // 0. Cost price: the old lines come off the average, the new ones go
      // on -- worked out against the shelf as it stands before either moves.
      if (wasReceived) {
        await this.averageCosts(tx, businessId, [
          ...existing.items.map((i) => ({
            productId: i.productId,
            quantity: -Number(i.quantity),
            costPrice: Number(i.costPrice),
          })),
          ...items,
        ]);
      }

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
            await this.reverseBatchIfNeeded(tx, existing.storeId, item, batched.has(item.productId));
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
          // `?? null` cleared each of these whenever the client left it out,
          // which is fine while the web form posts every field and becomes
          // silent data loss the moment anything sends a partial patch. Absent
          // must mean "leave it alone"; only an explicit null clears.
          ...(supplierId !== undefined ? { supplierId } : {}),
          ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          subtotal,
          tax,
          total,
          amountPaid,
          ...(owedBack > 0 ? { refundDue: owedBack } : {}),
          items: {
            create: items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              costPrice: i.costPrice,
              taxRate: i.taxRate ?? 0,
              batchNumber: i.batchNumber,
              expiryDate: i.expiryDate ? new Date(i.expiryDate) : null,
            })),
          },
        },
      });

      // An edit can change what was paid directly: a correction, recorded as
      // the money it says moved, so the supplier's payments still add up to
      // what their invoices say was paid. What a smaller total merely clamps
      // off is owed back instead (refundDue above), not money that moved.
      const paidDelta = round2(amountPaid - paidBefore + owedBack);
      if (paidDelta !== 0) {
        await this.payments.record(
          {
            businessId,
            type:
              paidDelta > 0
                ? PaymentType.SUPPLIER_PAYMENT
                : PaymentType.SUPPLIER_REFUND,
            amount: Math.abs(paidDelta),
            method: dto.paymentMethod ?? PaymentMethod.CASH,
            // Whoever the purchase is with after this edit, including the
            // supplier it kept when the edit didn't mention one.
            supplierId: supplierId === undefined ? existing.supplierId : supplierId,
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
          await this.receiveBatch(tx, businessId, newStoreId, batched.has(item.productId), {
            productId: item.productId,
            quantity: item.quantity,
            costPrice: new Prisma.Decimal(item.costPrice),
            batchNumber: item.batchNumber ?? null,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
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
      select: { id: true, name: true, trackSerials: true, trackBatches: true },
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

      // Cost price: the delivery averaged into what is already on the
      // shelf, read before the stock below moves.
      await this.averageCosts(
        tx,
        businessId,
        purchase.items.map((i) => ({
          productId: i.productId,
          quantity: Number(i.quantity),
          costPrice: Number(i.costPrice),
        })),
      );

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

      // Batches and serials stay per line: each carries per-item logic
      // (natural-key batch merge, serial reconciliation) that does not reduce
      // to a single statement. A throw anywhere still rolls the whole receive
      // back.
      const arriving = PurchasesService.arrivingByProduct(purchase.items);
      for (const item of purchase.items) {
        await this.receiveBatch(
          tx,
          businessId,
          purchase.storeId,
          !!productMap.get(item.productId)?.trackBatches,
          item,
          arriving.get(item.productId),
        );
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
    actor?: AuthUser,
  ) {
    const purchase = await this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: { items: true },
    });
    if (!purchase) throw new NotFoundException('Purchase not found');
    // A stock keeper sends back goods from the shelf they stand at.
    if (actor) assertOwnStore(actor, purchase.storeId);
    if (purchase.status !== PurchaseStatus.RECEIVED) {
      throw new BadRequestException(
        'Only a received purchase can be returned to the supplier',
      );
    }

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
    const batched = await this.batchTracked(
      businessId,
      purchase.items.map((i) => i.productId),
    );

    return this.prisma.$transaction(async (tx) => {
      // Everything that decides the money is read under the purchase's row
      // lock. The totals below are written as values, not increments, so
      // worked out from a copy read before this transaction they overwrote
      // whatever landed in between: a supplier payment recorded at the same
      // moment vanished from amountPaid (the ledger still had it, so the
      // Credit page asked for it again), and two returns on different lines
      // each wrote a total that only took off their own goods.
      await tx.$queryRaw`SELECT id FROM "Purchase" WHERE id = ${purchase.id} FOR UPDATE`;
      const locked = await tx.purchase.findUniqueOrThrow({
        where: { id: purchase.id },
        include: { items: true },
      });
      if (locked.status !== PurchaseStatus.RECEIVED) {
        throw new BadRequestException(
          'Only a received purchase can be returned to the supplier',
        );
      }
      const itemMap = new Map(locked.items.map((it) => [it.id, it]));
      let value = 0;
      let vatBack = 0;
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
        // The VAT charged on the goods goes back with them.
        vatBack += (Number(item.costPrice) * r.quantity * Number(item.taxRate)) / 100;
      }
      value = round2(value);
      vatBack = round2(vatBack);
      const newSubtotal = round2(Number(locked.subtotal) - value);
      const newTax = round2(Math.max(Number(locked.tax) - vatBack, 0));
      const newTotal = round2(Number(locked.total) - value - vatBack);
      // Returning goods shrinks what is owed, but the money already handed
      // over doesn't shrink with it. Without clamping, a return against a
      // fully-paid purchase left amountPaid above total and `outstanding` went
      // negative -- a nonsense balance that reads as "the supplier owes us"
      // everywhere it is displayed. Clamp it, and report the excess as what it
      // is: money the supplier now owes back, settled outside this record.
      const paidBefore = Number(locked.amountPaid);
      const newAmountPaid = round2(Math.min(paidBefore, Math.max(newTotal, 0)));
      const refundDueFromSupplier = round2(paidBefore - newAmountPaid);

      // The goods leave the average at the cost they came in at.
      await this.averageCosts(
        tx,
        businessId,
        dto.items.map((r) => {
          const item = itemMap.get(r.purchaseItemId)!;
          return { productId: item.productId, quantity: -r.quantity, costPrice: Number(item.costPrice) };
        }),
      );

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
        await this.reverseBatchIfNeeded(
          tx,
          purchase.storeId,
          {
            productId: item.productId,
            quantity: r.quantity,
            batchNumber: item.batchNumber,
            expiryDate: item.expiryDate,
          },
          batched.has(item.productId),
        );
        if (serialised.has(item.productId)) {
          await this.inventory.returnSerialsToSupplier(tx, {
            businessId,
            productId: item.productId,
            purchaseId: purchase.id,
            storeId: purchase.storeId,
            quantity: r.quantity,
            serials: r.serials,
          });
        }
      }

      // Clamping amountPaid down to the new total is money the supplier now
      // owes back. Owed, not received: it goes on the purchase as refundDue,
      // and reaches the ledger only when the refund actually arrives
      // (recordRefundReceived). Writing the ledger row here claimed money had
      // come in that hadn't, and left what was still owed recorded nowhere.
      const updated = await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          subtotal: newSubtotal,
          tax: newTax,
          total: newTotal,
          amountPaid: newAmountPaid,
          ...(refundDueFromSupplier > 0
            ? { refundDue: { increment: refundDueFromSupplier } }
            : {}),
          note: dto.note ?? locked.note,
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
   * Received purchase lines some stock could be sent back against, newest
   * delivery first.
   *
   * For a batch, only lines with its batch number and expiry: that is the
   * batch the return reverses (reverseBatchIfNeeded matches on the same
   * pair), so a line from another delivery would take the wrong batch down.
   * A product without batches can go back against any delivery of it.
   */
  async returnableLines(
    businessId: string,
    q: { storeId: string; productId: string; batchId?: string },
    actor?: AuthUser,
  ) {
    if (actor) assertOwnStore(actor, q.storeId);
    let batch: { batchNumber: string | null; expiryDate: Date | null; quantity: Prisma.Decimal } | null = null;
    if (q.batchId) {
      batch = await this.prisma.batch.findFirst({
        where: { id: q.batchId, businessId, storeId: q.storeId, productId: q.productId },
        select: { batchNumber: true, expiryDate: true, quantity: true },
      });
      if (!batch) throw new NotFoundException('Batch not found');
    }
    const lines = await this.prisma.purchaseItem.findMany({
      where: {
        productId: q.productId,
        purchase: { businessId, storeId: q.storeId, status: PurchaseStatus.RECEIVED },
        ...(batch ? { batchNumber: batch.batchNumber, expiryDate: batch.expiryDate } : {}),
      },
      select: {
        id: true,
        quantity: true,
        returnedQty: true,
        costPrice: true,
        purchase: {
          select: {
            id: true,
            reference: true,
            receivedAt: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { purchase: { receivedAt: 'desc' } },
      take: 20,
    });
    return lines
      .map((l) => ({
        purchaseId: l.purchase.id,
        purchaseItemId: l.id,
        reference: l.purchase.reference,
        receivedAt: l.purchase.receivedAt,
        supplier: l.purchase.supplier,
        costPrice: Number(l.costPrice),
        returnable: round3(Number(l.quantity) - Number(l.returnedQty)),
      }))
      .filter((l) => l.returnable > 0);
  }

  /**
   * The supplier has paid back what they owed on this purchase (or part of
   * it). This is when the money actually moves, so it is when the ledger gets
   * its SUPPLIER_REFUND row -- in the same transaction as the balance, the
   * guarded decrement keeping two recordings from both clearing it.
   */
  async recordRefundReceived(
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
      const claimed = await tx.purchase.updateMany({
        where: { id, businessId, refundDue: { gte: amount } },
        data: { refundDue: { decrement: amount } },
      });
      if (claimed.count === 0) {
        throw new BadRequestException(
          `That is more than the ${round2(Number(purchase.refundDue))} the supplier owes back`,
        );
      }
      await this.payments.record(
        {
          businessId,
          type: PaymentType.SUPPLIER_REFUND,
          amount,
          method: context.method ?? PaymentMethod.CASH,
          supplierId: purchase.supplierId,
          purchaseId: id,
          storeId: purchase.storeId,
          // No shiftId, like a supplier payment: not a till transaction.
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
        // For the details dialog: what was paid when, and which units came in.
        payments: {
          where: { type: { in: [PaymentType.SUPPLIER_PAYMENT, PaymentType.SUPPLIER_REFUND] } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            method: true,
            amount: true,
            createdAt: true,
            user: { select: { name: true } },
          },
        },
        serials: { select: { productId: true, serialNumber: true, status: true }, orderBy: { serialNumber: 'asc' } },
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
    productMap: Map<string, { id: string; trackBatches: boolean }>,
  ) {
    // Cost price first: the delivery averaged into what is already on the
    // shelf, which has to be read before the stock below moves.
    await this.averageCosts(tx, businessId, dto.items);

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

    // Batches and serials stay per line: each carries per-item logic
    // (natural-key batch merge, serial reconciliation) that doesn't reduce
    // to a single statement. A throw anywhere still rolls the whole purchase
    // back.
    const arriving = PurchasesService.arrivingByProduct(dto.items);
    for (const item of dto.items) {
      await this.receiveBatch(tx, businessId, storeId, !!productMap.get(item.productId)?.trackBatches, {
        productId: item.productId,
        quantity: item.quantity,
        costPrice: new Prisma.Decimal(item.costPrice),
        batchNumber: item.batchNumber ?? null,
        expiryDate: item.expiryDate ? new Date(item.expiryDate) : null,
      }, arriving.get(item.productId));
      await this.inventory.receiveSerials(tx, {
        businessId,
        storeId,
        productId: item.productId,
        purchaseId,
        serials: item.serials ?? [],
      });
    }
  }

  /** Which of these products are tracked by batch. */
  private async batchTracked(businessId: string, productIds: string[]) {
    const rows = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(productIds)] }, businessId, trackBatches: true },
      select: { id: true },
    });
    return new Set(rows.map((p) => p.id));
  }

  /**
   * Set each product's cost price to the weighted average of the stock on
   * hand (across every branch -- the cost is one figure per product) and the
   * quantities moving in, or back out when negative, at their costs. Call it
   * before the stock moves: it reads the shelf as it stands.
   */
  private async averageCosts(
    tx: Prisma.TransactionClient,
    businessId: string,
    moves: { productId: string; quantity: number; costPrice: number }[],
  ) {
    if (moves.length === 0) return;
    const ids = [...new Set(moves.map((m) => m.productId))];
    const [products, stock] = await Promise.all([
      tx.product.findMany({
        where: { id: { in: ids }, businessId },
        select: { id: true, costPrice: true },
      }),
      tx.stockItem.groupBy({
        by: ['productId'],
        where: { businessId, productId: { in: ids } },
        _sum: { quantity: true },
      }),
    ]);
    const onHand = new Map(stock.map((r) => [r.productId, Number(r._sum.quantity ?? 0)]));
    for (const p of products) {
      const current = Number(p.costPrice);
      const cost = weightedCost(
        onHand.get(p.id) ?? 0,
        current,
        moves.filter((m) => m.productId === p.id),
      );
      if (cost !== current) {
        await tx.product.update({ where: { id: p.id }, data: { costPrice: cost } });
      }
    }
  }

  /**
   * The batch side of goods arriving. A batch-tracked product always gets
   * one -- undated when the delivery didn't say -- or its batches stop
   * adding up to the shelf. Any other product has no batches to draw down
   * (a sale only consumes them for tracked products), so a batch made for it
   * sat on the Expiring list for good; its expiry date, if given, is kept on
   * the product instead, as Import stock does.
   */
  private async receiveBatch(
    tx: Prisma.TransactionClient,
    businessId: string,
    storeId: string,
    trackBatches: boolean,
    item: {
      productId: string;
      quantity: Prisma.Decimal | number;
      costPrice: Prisma.Decimal;
      batchNumber: string | null;
      expiryDate: Date | null;
    },
    /**
     * Units of this product the delivery has already put on the shelf at
     * this store -- its other lines included -- so a switch to batches
     * doesn't date them with the old stock.
     */
    arriving = Number(item.quantity),
  ) {
    if (trackBatches) {
      await this.inventory.addToBatch(tx, {
        businessId,
        storeId,
        productId: item.productId,
        quantity: item.quantity,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
        costPrice: item.costPrice,
      });
    } else if (item.expiryDate) {
      const current = await tx.product.findUniqueOrThrow({
        where: { id: item.productId },
        select: { trackBatches: true, expiryDate: true },
      });
      // An earlier line of this delivery already moved it onto batches.
      if (current.trackBatches) {
        await this.receiveBatch(tx, businessId, storeId, true, item);
        return;
      }
      const newDate = current.expiryDate?.getTime() !== item.expiryDate.getTime();
      const oldStock = newDate && current.expiryDate ? await this.stockBesides(tx, item.productId, storeId, arriving) : 0;
      if (oldStock > 0) {
        // Stock on the shelf already carries another date. Overwriting it
        // made those units read as fresh; keep both dates on batches.
        await convertToBatches(tx, item.productId, { storeId, quantity: arriving });
        await this.receiveBatch(tx, businessId, storeId, true, item);
        return;
      }
      await tx.product.update({
        where: { id: item.productId },
        data: { expiryDate: item.expiryDate },
      });
    }
  }

  /** Units of a product on hand anywhere, besides what is arriving here. */
  private async stockBesides(
    tx: Prisma.TransactionClient,
    productId: string,
    storeId: string,
    arriving: number,
  ) {
    const rows = await tx.stockItem.findMany({
      where: { productId, quantity: { gt: 0 } },
      select: { storeId: true, quantity: true },
    });
    return round3(
      rows.reduce((sum, r) => sum + Number(r.quantity) - (r.storeId === storeId ? arriving : 0), 0),
    );
  }

  /** Per product, what a delivery's lines add up to. */
  private static arrivingByProduct(items: { productId: string; quantity: Prisma.Decimal | number }[]) {
    const total = new Map<string, number>();
    for (const i of items) total.set(i.productId, round3((total.get(i.productId) ?? 0) + Number(i.quantity)));
    return total;
  }

  /**
   * Mirror of receiveBatch for reversing a purchase edit or a supplier
   * return: decrements the matching batch instead of leaving a stale row
   * behind. A dated batch with less in it than is going back has been sold
   * from, so that refuses (same as the stock reversal). An undated one may
   * predate undated batches being kept at all, so it gives up what it has.
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
    trackBatches: boolean,
  ) {
    if (!trackBatches) return;
    const existing = await tx.batch.findFirst({
      where: {
        storeId,
        productId: item.productId,
        batchNumber: item.batchNumber,
        expiryDate: item.expiryDate,
      },
    });
    if (!existing) return; // nothing tracked to reverse
    const have = Number(existing.quantity);
    const take = Number(item.quantity);
    const dated = !!item.batchNumber || !!item.expiryDate;
    if (have < take && dated) {
      throw new BadRequestException('That batch stock has already been sold or moved');
    }
    await tx.batch.update({
      where: { id: existing.id },
      data: { quantity: { decrement: String(round3(Math.min(have, take))) } },
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
