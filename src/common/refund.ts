const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What handing back `qty` units of one sale line is worth.
 *
 * A line's `lineTotal` is its value before the bill-level discount: the sale's
 * `total` is `subtotal + tax - discount`, and the discount belongs to the bill,
 * not to any line. Refunding `lineTotal / quantity` per unit therefore handed
 * the whole discount back on top of the goods -- a 100 sale with 10 off,
 * returned in full, refunded 100 for the 90 the customer paid.
 *
 * The discount is shared across the lines in proportion to their value, which
 * is `total / (subtotal + tax)` of every line. Unrounded, so a caller adding up
 * several lines rounds once at the end.
 */
export function lineRefund(
  sale: { subtotal: unknown; tax: unknown; total: unknown },
  line: { lineTotal: unknown; quantity: unknown },
  qty: number,
): number {
  const quantity = Number(line.quantity);
  if (!quantity) return 0;
  const gross = Number(sale.subtotal) + Number(sale.tax);
  // No gross means nothing was charged for any line, so nothing comes back.
  const share = gross > 0 ? Number(sale.total) / gross : 0;
  return (Number(line.lineTotal) / quantity) * qty * share;
}

/**
 * The refund for one return against a sale, never more than is left of it.
 *
 * The return that brings the last unit back refunds exactly what remains, so
 * the per-line shares -- each rounded to the paisa on its own -- can't leave a
 * stray paisa behind or overshoot the total between them.
 */
export function returnRefund(
  sale: { total: unknown; refundedTotal: unknown },
  itemsValue: number,
  closesTheSale: boolean,
): number {
  const remaining = Math.max(round2(Number(sale.total) - Number(sale.refundedTotal)), 0);
  return closesTheSale ? remaining : Math.min(round2(itemsValue), remaining);
}
