-- Internal notes on a business, for the admin panel (FEATURES.md 3.5).
--
-- Purely additive: a new table, nothing existing is touched.
--
-- The admin link is SET NULL, with the email kept as a snapshot, so removing an
-- admin account doesn't take their notes with it. Deleting the business does.

-- CreateTable
CREATE TABLE "BusinessNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "adminId" TEXT,
    "adminEmail" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessNote_businessId_createdAt_idx" ON "BusinessNote"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "BusinessNote" ADD CONSTRAINT "BusinessNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessNote" ADD CONSTRAINT "BusinessNote_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
