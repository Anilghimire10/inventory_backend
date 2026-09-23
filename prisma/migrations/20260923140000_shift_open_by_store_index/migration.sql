-- "Which tills are open at this branch?"
--
-- An owner or manager with no till of their own now joins the shift already
-- open at the store rather than opening a second one for the same physical
-- drawer. That question is asked on every POS load and again on every sale, so
-- it gets an index rather than a scan of the store's whole shift history.
--
-- Plain rather than partial on `closedAt IS NULL`, even though the lookup only
-- ever wants the open rows: this one is declared in schema.prisma, and Prisma
-- cannot express a partial index, so making it partial here would show up as
-- drift on every `migrate diff`. The closed rows cost some index size and
-- nothing in selectivity -- `closedAt` is the second column, so the open rows
-- for a store are still one contiguous range.
CREATE INDEX "Shift_storeId_closedAt_idx"
  ON "Shift" ("storeId", "closedAt");
