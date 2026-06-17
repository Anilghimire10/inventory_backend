-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "isSubscribed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "subscribedTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "taxId" TEXT;

-- CreateTable
CREATE TABLE "Tax" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tax_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tax_businessId_idx" ON "Tax"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Tax_businessId_name_key" ON "Tax"("businessId", "name");

-- AddForeignKey
ALTER TABLE "Tax" ADD CONSTRAINT "Tax_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_taxId_fkey" FOREIGN KEY ("taxId") REFERENCES "Tax"("id") ON DELETE SET NULL ON UPDATE CASCADE;

