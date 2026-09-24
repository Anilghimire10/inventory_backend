-- Payment ledger.
--
-- Paying down a customer's udhaaro or settling a supplier invoice used to move
-- a balance and nothing else: Customer."creditBalance" down, Purchase."amountPaid"
-- up, with no record of who paid, when, or by what means. "When did I pay that
-- 5,000?" had no answer, and cash taken against credit at the counter never
-- reached the shift's expected cash, so the drawer could not be balanced.
--
-- Purely additive: no existing table is touched and no data is migrated, so
-- this is safe to apply to a live database while the old code is still running.
-- Rows only begin appearing once the writing code ships.
--
-- Every party FK is ON DELETE SET NULL rather than CASCADE. Deleting a customer
-- must never delete the record that money changed hands; the row survives with
-- the link cleared.

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('SALE', 'REFUND', 'CUSTOMER_CREDIT', 'SUPPLIER_PAYMENT');

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "storeId" TEXT,
    "type" "PaymentType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "customerId" TEXT,
    "supplierId" TEXT,
    "saleId" TEXT,
    "purchaseId" TEXT,
    "shiftId" TEXT,
    "userId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_businessId_createdAt_idx" ON "Payment"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_customerId_createdAt_idx" ON "Payment"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_supplierId_createdAt_idx" ON "Payment"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_shiftId_idx" ON "Payment"("shiftId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
