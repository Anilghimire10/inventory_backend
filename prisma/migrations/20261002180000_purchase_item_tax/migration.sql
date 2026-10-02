-- VAT the supplier charged on each purchase line, so the tax report can show
-- input VAT (paid on purchases) beside output VAT (collected on sales).
-- Existing lines were entered without it: 0, which is what they were.
ALTER TABLE "PurchaseItem" ADD COLUMN "taxRate" DECIMAL(5,2) NOT NULL DEFAULT 0;
