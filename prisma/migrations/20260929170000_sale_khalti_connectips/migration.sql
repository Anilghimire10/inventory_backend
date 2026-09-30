-- Shops can take Khalti and connectIPS from their own customers: two more
-- tenders for sales, khata payments, refunds and supplier payments. Like card
-- and QR, neither touches a till's cash. Additive.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'KHALTI';
ALTER TYPE "PaymentMethod" ADD VALUE 'CONNECTIPS';
