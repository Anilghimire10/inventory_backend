-- Per-account lockout for wrong two-factor codes (TASKS.md T32).
--
-- Additive: a counter with a default and a nullable timestamp. The login
-- route is throttled per IP only, so without these an attacker who has the
-- password could spread code guesses across addresses.

-- AlterTable
ALTER TABLE "PlatformAdmin" ADD COLUMN "totpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "totpLockedUntil" TIMESTAMP(3);
