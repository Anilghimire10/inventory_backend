-- Weighed goods: quantities become fractional (Int -> Decimal(12,3)).
ALTER TABLE "StockItem" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3);
ALTER TABLE "Batch" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3);
ALTER TABLE "StockMovement" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3);
ALTER TABLE "SaleItem"
  ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3),
  ALTER COLUMN "returnedQty" SET DATA TYPE DECIMAL(12,3);
ALTER TABLE "PurchaseItem" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(12,3);

-- Purchase return / debit note: how much of each line went back to the supplier.
ALTER TABLE "PurchaseItem" ADD COLUMN "returnedQty" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- Shift / cash drawer session.
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "openingFloat" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "countedCash" DECIMAL(12,2),
    "expectedCash" DECIMAL(12,2),
    "variance" DECIMAL(12,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Shift_businessId_openedAt_idx" ON "Shift"("businessId", "openedAt");
CREATE INDEX "Shift_userId_closedAt_idx" ON "Shift"("userId", "closedAt");

-- A user may only have one shift open at a time. Partial unique index rather
-- than app-level checking: two concurrent "open shift" requests would both
-- pass a read-then-write check, this one can't be raced.
CREATE UNIQUE INDEX "Shift_userId_open_key" ON "Shift"("userId") WHERE "closedAt" IS NULL;

ALTER TABLE "Shift" ADD CONSTRAINT "Shift_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sales are stamped with the till session they were rung up in.
ALTER TABLE "Sale" ADD COLUMN "shiftId" TEXT;
CREATE INDEX "Sale_shiftId_idx" ON "Sale"("shiftId");
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
