-- Product variants: a variant is just another product row pointing at its parent.
ALTER TABLE "Product"
  ADD COLUMN "parentId" TEXT,
  ADD COLUMN "variantName" TEXT,
  ADD COLUMN "attributes" JSONB,
  ADD COLUMN "trackSerials" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Product_parentId_idx" ON "Product"("parentId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Serial / IMEI tracking: one row per physical unit of a serialised product.
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'SOLD', 'RETURNED_TO_SUPPLIER');

CREATE TABLE "Serial" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storeId" TEXT,
    "serialNumber" TEXT NOT NULL,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "purchaseId" TEXT,
    "saleId" TEXT,
    "soldAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Serial_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Serial_businessId_serialNumber_key" ON "Serial"("businessId", "serialNumber");
CREATE INDEX "Serial_businessId_status_idx" ON "Serial"("businessId", "status");
CREATE INDEX "Serial_storeId_productId_status_idx" ON "Serial"("storeId", "productId", "status");
CREATE INDEX "Serial_saleId_idx" ON "Serial"("saleId");
CREATE INDEX "Serial_purchaseId_idx" ON "Serial"("purchaseId");

ALTER TABLE "Serial" ADD CONSTRAINT "Serial_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Serial" ADD CONSTRAINT "Serial_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Serial" ADD CONSTRAINT "Serial_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Serial" ADD CONSTRAINT "Serial_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Serial" ADD CONSTRAINT "Serial_saleId_fkey"
  FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
