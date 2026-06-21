-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "taxEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "isTaxable" BOOLEAN NOT NULL DEFAULT true;
