-- AlterTable
ALTER TABLE "User" ADD COLUMN     "counterId" TEXT;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "counterId" TEXT;

-- CreateTable
CREATE TABLE "Counter" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Counter_businessId_idx" ON "Counter"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Counter_storeId_name_key" ON "Counter"("storeId", "name");

-- CreateIndex
CREATE INDEX "Shift_counterId_closedAt_idx" ON "Shift"("counterId", "closedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "Counter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "Counter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Counter" ADD CONSTRAINT "Counter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Counter" ADD CONSTRAINT "Counter_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Data: every store gets its counters, and every cashier one of them.
-- ---------------------------------------------------------------------------

-- A cashier in a shop with a single store works there: say so, so they can be
-- given a counter in it.
UPDATE "User" u
SET "storeId" = s.id
FROM "Store" s
WHERE u.role = 'CASHIER'
  AND u."storeId" IS NULL
  AND s."businessId" = u."businessId"
  AND (SELECT count(*) FROM "Store" x WHERE x."businessId" = u."businessId") = 1;

-- One counter per active cashier at a store -- each cashier already counted
-- their own drawer, and still does -- and at least "Counter 1" everywhere.
INSERT INTO "Counter" ("id", "businessId", "storeId", "name", "isActive", "createdAt", "updatedAt")
SELECT
  'c' || substr(md5(random()::text || clock_timestamp()::text || s.id || n::text), 1, 24),
  s."businessId",
  s.id,
  'Counter ' || n,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Store" s
CROSS JOIN LATERAL generate_series(
  1,
  GREATEST(1, (SELECT count(*) FROM "User" u
               WHERE u.role = 'CASHIER' AND u."isActive" AND u."storeId" = s.id))
) AS n;

-- Cashier n at a store (oldest first) gets Counter n there.
WITH ranked AS (
  SELECT u.id, u."storeId",
         row_number() OVER (PARTITION BY u."storeId" ORDER BY u."createdAt", u.id) AS n
  FROM "User" u
  WHERE u.role = 'CASHIER' AND u."isActive" AND u."storeId" IS NOT NULL
)
UPDATE "User" u
SET "counterId" = c.id
FROM ranked r
JOIN "Counter" c ON c."storeId" = r."storeId" AND c.name = 'Counter ' || r.n
WHERE u.id = r.id;

-- A cashier's shift open now is their counter's drawer. Owners' open shifts
-- keep no counter until they are closed.
UPDATE "Shift" sh
SET "counterId" = u."counterId"
FROM "User" u
JOIN "Counter" c ON c.id = u."counterId"
WHERE sh."userId" = u.id
  AND sh."closedAt" IS NULL
  AND c."storeId" = sh."storeId";

-- One drawer, one count: at most one open shift per counter.
CREATE UNIQUE INDEX "Shift_counterId_open_key"
  ON "Shift" ("counterId")
  WHERE "closedAt" IS NULL AND "counterId" IS NOT NULL;
