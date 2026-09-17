-- Make a RETURNED sale say so on its lines, not only in `status`.
--
-- The reports net returns at two levels: sale level via refundedTotal
-- (dashboard, sales list, analytics gross) and line level via
-- quantity - returnedQty (tax report, analytics net revenue/cost/units).
-- A sale whose status was set directly -- the seed script does this, and so
-- would any row edited by hand -- has returnedQty still 0 on every line, so
-- the two levels disagree about the same sale: the sale-level figures treat
-- it as fully refunded while the line-level ones count every unit as sold
-- and taxed.
--
-- This only became visible once returned sales stopped being excluded from
-- reporting outright. Align the lines with the status.

UPDATE "SaleItem" i
SET "returnedQty" = i.quantity
FROM "Sale" s
WHERE s.id = i."saleId"
  AND s.status = 'RETURNED'
  AND i."returnedQty" = 0;
