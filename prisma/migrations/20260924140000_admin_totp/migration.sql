-- Two-factor sign-in for platform admins (FEATURES.md 3.9).
--
-- Additive: three nullable columns. Admins without them sign in exactly as
-- before; two-factor is opt-in per admin from the Account page.

-- AlterTable
ALTER TABLE "PlatformAdmin" ADD COLUMN "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN "totpLastStep" INTEGER,
ADD COLUMN "totpSecret" TEXT;
