-- Cash control on shifts: pay in / pay out, float carried between shifts,
-- counting by denomination, and the blind-close / variance-note settings.
--
-- Until now the only cash a drawer could explain was sales, refunds and
-- credit collected, so paying for tea or a supplier out of the till showed up
-- at close as the cashier being short. Everything here is additive: existing
-- shifts read exactly as before, with no movements and no carried float.

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('PAY_IN', 'PAY_OUT');

-- CreateEnum
CREATE TYPE "CashMovementReason" AS ENUM ('FLOAT_TOPUP', 'EXPENSE', 'SUPPLIER', 'SAFE_DROP', 'OWNER_DRAW', 'OTHER');

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "shiftBlindClose" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shiftVarianceNoteOver" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "carriedFloat" DECIMAL(12,2),
ADD COLUMN     "cashCount" JSONB,
ADD COLUMN     "cashLeft" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "reason" "CashMovementReason" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashMovement_shiftId_createdAt_idx" ON "CashMovement"("shiftId", "createdAt");

-- CreateIndex
CREATE INDEX "CashMovement_businessId_createdAt_idx" ON "CashMovement"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A movement's direction is its type; an amount of zero or less would only
-- let a pay out be recorded as a disguised pay in.
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_amount_positive" CHECK ("amount" > 0);
