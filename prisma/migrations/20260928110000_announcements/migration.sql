-- Announcements get a table of their own: needed to schedule one for later
-- and to count who has seen it. Until now the only record was the admin-log
-- entry written when one was sent.

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "announcementId" TEXT;

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "businessIds" TEXT[],
    "email" BOOLEAN NOT NULL DEFAULT false,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "businesses" INTEGER,
    "emailed" INTEGER,
    "failed" INTEGER,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_scheduledFor_sentAt_idx" ON "Announcement"("scheduledFor", "sentAt");

-- CreateIndex
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_announcementId_idx" ON "Notification"("announcementId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Carry the history over: one Announcement per past send, from its admin-log
-- entry (whose id it keeps). Which shops a "selected" send went to was never
-- stored, so businessIds stays empty for those; `businesses` has the count.
INSERT INTO "Announcement" (
  "id", "title", "body", "audience", "businessIds", "email", "createdByEmail",
  "createdAt", "sentAt", "businesses", "emailed", "failed"
)
SELECT l."id",
       l."details"->>'title',
       l."details"->>'body',
       COALESCE(l."details"->>'audience', 'all'),
       ARRAY[]::TEXT[],
       COALESCE((l."details"->>'email')::boolean, false),
       l."adminEmail",
       l."createdAt",
       l."createdAt",
       NULLIF(l."details"->>'businesses', '')::int,
       NULLIF(l."details"->>'emailed', '')::int,
       NULLIF(l."details"->>'failed', '')::int
FROM "PlatformAuditLog" l
WHERE l."action" = 'announcement.send'
  AND l."details"->>'title' IS NOT NULL;

-- And link the notifications each one created: same title and text, written
-- in the few minutes before the log entry (emails go out in between).
UPDATE "Notification" n
SET "announcementId" = a."id"
FROM "Announcement" a
WHERE n."announcementId" IS NULL
  AND n."type" = 'GENERAL'
  AND n."title" = a."title"
  AND n."body" = a."body"
  AND n."createdAt" BETWEEN a."createdAt" - INTERVAL '10 minutes' AND a."createdAt";
