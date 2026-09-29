-- Support ticket categories, and notifications meant for one person (the
-- reply to their own support ticket). Additive: every existing ticket becomes
-- OTHER, and every existing notification stays business-wide (userId null).

-- CreateEnum
CREATE TYPE "SupportTicketCategory" AS ENUM ('BILLING', 'PROBLEM', 'HOW_TO', 'FEATURE', 'OTHER');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "category" "SupportTicketCategory" NOT NULL DEFAULT 'OTHER';

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

