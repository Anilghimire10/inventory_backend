-- Auth hardening + the composite indexes the sale/movement lists actually need.
--
-- 1. EmailToken.attempts
--    A verify/reset code is 6 digits and lives 15 minutes. The only thing
--    guarding it was a per-IP rate limit, which a spread of IPs walks straight
--    past. Counting wrong guesses on the token row caps the attempts per
--    *code* instead, wherever they come from.
--
-- 2. User.tokenVersion
--    Access tokens are stateless and last 7 days, so a password reset did not
--    actually end a stolen session. Tokens now carry the version they were
--    minted with and the strategy rejects stale ones, so bumping this on a
--    password change signs every existing session out.
--
-- 3. Sale/StockMovement (businessId, createdAt)
--    Both lists filter on businessId and range/sort on createdAt. Separate
--    single-column indexes cannot serve that as one lookup.

ALTER TABLE "EmailToken" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Sale_businessId_createdAt_idx" ON "Sale"("businessId", "createdAt");

CREATE INDEX "StockMovement_businessId_createdAt_idx" ON "StockMovement"("businessId", "createdAt");
