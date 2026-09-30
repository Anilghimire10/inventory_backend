-- How shops pay: a price line, instructions and payment methods (with QR
-- codes), set in admin Settings and shown on the shop's Subscription page.
-- Additive.

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "paymentInstructions" TEXT,
ADD COLUMN     "paymentMethods" JSONB,
ADD COLUMN     "subscriptionPrice" TEXT;

