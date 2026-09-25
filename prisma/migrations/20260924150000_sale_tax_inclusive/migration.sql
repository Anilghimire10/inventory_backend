-- Business.taxInclusive was stored and editable but never used: pricing always
-- added tax on top. Sales now honour it, and snapshot it so a later change to
-- the setting doesn't reinterpret sales already rung up.
--
-- Purely additive. Every existing sale was priced tax-exclusive, which is what
-- the default says.
ALTER TABLE "Sale" ADD COLUMN "taxInclusive" BOOLEAN NOT NULL DEFAULT false;
