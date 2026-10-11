-- Which batch each sale line's units came out of, so a return puts them back
-- where they were sold from instead of guessing (which could file a good unit
-- under an expired batch). Sales made before this have no rows and keep the
-- inferred rule.
--
-- Clearance prices: a batch, or a product's own dated stock at one store,
-- marked down to sell before it expires.
-- AlterTable
ALTER TABLE "StockItem" ADD COLUMN     "clearanceFor" TIMESTAMP(3),
ADD COLUMN     "clearancePrice" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "clearancePrice" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "SaleItemBatch" (
    "id" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "returnedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "SaleItemBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SaleItemBatch_saleItemId_idx" ON "SaleItemBatch"("saleItemId");

-- CreateIndex
CREATE INDEX "SaleItemBatch_batchId_idx" ON "SaleItemBatch"("batchId");

-- AddForeignKey
ALTER TABLE "SaleItemBatch" ADD CONSTRAINT "SaleItemBatch_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItemBatch" ADD CONSTRAINT "SaleItemBatch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

