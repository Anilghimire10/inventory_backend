-- Shift.refundsAtClose: the refunds figure on a Z report, frozen at close.
--
-- Expected cash, counted cash and variance were already snapshotted at close,
-- but the report's "refunds" and "net" were recomputed on every view from the
-- shift's sales -- so a return made days later against one of those sales
-- changed a Z report that had already been counted and signed off.
-- Nullable: shifts closed before this keep showing the live figure.
ALTER TABLE "Shift" ADD COLUMN "refundsAtClose" DECIMAL(12,2);
