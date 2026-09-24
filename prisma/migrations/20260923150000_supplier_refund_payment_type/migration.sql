-- Supplier refunds in the Payment ledger.
--
-- A return to a supplier, or an edit that lowers what was paid on a purchase,
-- takes Purchase."amountPaid" down. Without a type for money coming back from a
-- supplier, that change had no ledger row, and a supplier's payments could no
-- longer be reconciled against what their invoices say was paid.
--
-- Additive: an enum value only, safe to apply while the old code runs.

-- AlterEnum
ALTER TYPE "PaymentType" ADD VALUE 'SUPPLIER_REFUND';
