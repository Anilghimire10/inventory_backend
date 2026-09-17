-- Sale.refundedTotal: money handed back on returns against a sale.
--
-- Every revenue figure in the app excluded RETURNED *and* PARTIALLY_RETURNED
-- sales outright, so a 10,000 sale with one 200 item returned counted as zero
-- revenue rather than 9,800 -- understating takings by the entire value of any
-- sale a customer ever partly returned. There was no way to do better: the
-- refund was never stored, only the per-line returnedQty.
--
-- With the refund recorded on the sale, revenue becomes `total - refundedTotal`
-- and only HELD carts (which are not sales yet) need excluding.

ALTER TABLE "Sale" ADD COLUMN "refundedTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Backfill from the line items, using the same per-unit share of lineTotal
-- that SalesService.returnItems() charges a refund at:
--   refund = returnedQty * (lineTotal / quantity)
-- Guarded against a zero quantity so a malformed line can't divide by zero.
UPDATE "Sale" s
SET "refundedTotal" = COALESCE(r.refunded, 0)
FROM (
  SELECT
    "saleId",
    ROUND(SUM("returnedQty" * ("lineTotal" / NULLIF("quantity", 0))), 2) AS refunded
  FROM "SaleItem"
  WHERE "returnedQty" > 0
  GROUP BY "saleId"
) AS r
WHERE s.id = r."saleId";

-- A sale can be marked RETURNED without any line-level detail behind it: the
-- seed script assigns the status directly, and so would any row set by hand.
-- The query above computes a zero refund for those, which -- now that
-- RETURNED sales are no longer excluded from revenue -- would book their full
-- value as income, the exact overstatement this column exists to prevent.
-- Declared fully returned with nothing itemised means fully refunded.
UPDATE "Sale"
SET "refundedTotal" = "total"
WHERE status = 'RETURNED' AND "refundedTotal" = 0;
