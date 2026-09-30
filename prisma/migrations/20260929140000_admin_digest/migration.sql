-- The admins' daily summary email: an on/off setting, and the day it last
-- went out (so it is sent once a day however many servers run). Additive.

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "adminDigestEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "adminDigestSentOn" TEXT;

