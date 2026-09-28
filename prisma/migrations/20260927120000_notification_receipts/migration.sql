-- Read and dismissed are now per person, not per shop.
--
-- A notification goes to a whole business, but its readAt/dismissedAt lived on
-- the shared row: a cashier opening the bell marked every announcement read for
-- the owner too, and a cashier dismissing "Subscription ends in 9 days" hid it
-- from the owner for good. Each user now has their own receipt; no receipt
-- means unread and showing.

-- CreateTable
CREATE TABLE "NotificationReceipt" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),

    CONSTRAINT "NotificationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationReceipt_userId_idx" ON "NotificationReceipt"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationReceipt_notificationId_userId_key" ON "NotificationReceipt"("notificationId", "userId");

-- AddForeignKey
ALTER TABLE "NotificationReceipt" ADD CONSTRAINT "NotificationReceipt_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationReceipt" ADD CONSTRAINT "NotificationReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the old shop-wide state over to everyone in that shop, so nothing
-- already read or dismissed pops back up after the upgrade. Who actually saw
-- it was never recorded, so this is the only answer the data can give.
INSERT INTO "NotificationReceipt" ("id", "notificationId", "userId", "readAt", "dismissedAt")
SELECT gen_random_uuid()::text, n."id", u."id", n."readAt", n."dismissedAt"
FROM "Notification" n
JOIN "User" u ON u."businessId" = n."businessId"
WHERE n."readAt" IS NOT NULL OR n."dismissedAt" IS NOT NULL;

-- AlterTable
ALTER TABLE "Notification" DROP COLUMN "dismissedAt",
DROP COLUMN "readAt";
