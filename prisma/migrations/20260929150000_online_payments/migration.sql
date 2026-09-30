-- CreateEnum
CREATE TYPE "OnlinePaymentStatus" AS ENUM ('STARTED', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "onlinePlans" JSONB;

-- CreateTable
CREATE TABLE "OnlinePayment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "startedById" TEXT,
    "gateway" "SubscriptionPaymentMethod" NOT NULL,
    "months" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "OnlinePaymentStatus" NOT NULL DEFAULT 'STARTED',
    "gatewayRef" TEXT,
    "transactionId" TEXT,
    "failReason" TEXT,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlinePayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlinePayment_gatewayRef_key" ON "OnlinePayment"("gatewayRef");

-- CreateIndex
CREATE UNIQUE INDEX "OnlinePayment_paymentId_key" ON "OnlinePayment"("paymentId");

-- CreateIndex
CREATE INDEX "OnlinePayment_status_createdAt_idx" ON "OnlinePayment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OnlinePayment_businessId_createdAt_idx" ON "OnlinePayment"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "OnlinePayment" ADD CONSTRAINT "OnlinePayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlinePayment" ADD CONSTRAINT "OnlinePayment_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnlinePayment" ADD CONSTRAINT "OnlinePayment_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "SubscriptionPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

