-- Each shop chooses the tenders it takes (Settings -> Payment methods):
-- Cash, Card, Mobile / QR, Khalti, connectIPS. Existing shops keep the three
-- they had; Khalti and connectIPS are off until the owner turns them on.
-- Additive.

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "acceptedTenders" "PaymentMethod"[] DEFAULT ARRAY['CASH', 'CARD', 'MOBILE']::"PaymentMethod"[];
