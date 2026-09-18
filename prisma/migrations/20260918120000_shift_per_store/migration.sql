-- One open shift per user PER STORE, instead of one per user.
--
-- An owner who works more than one branch had to close the till at the first
-- before selling at the second, because a single open shift blocked the rest.
-- Each store reconciles its own drawer, so the sessions are independent: what
-- must never happen is two open shifts at the SAME store for the same user,
-- which is what this index still prevents.
DROP INDEX IF EXISTS "Shift_userId_open_key";

CREATE UNIQUE INDEX "Shift_userId_storeId_open_key"
  ON "Shift"("userId", "storeId")
  WHERE "closedAt" IS NULL;
