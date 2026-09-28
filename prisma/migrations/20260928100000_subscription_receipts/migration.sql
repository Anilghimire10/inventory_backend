-- Subscription receipts: a receipt number on every payment, and the
-- platform's own billing details to print on it. Additive.

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "billingName" TEXT,
ADD COLUMN     "billingPhone" TEXT,
ADD COLUMN     "billingTaxId" TEXT;

-- Number the payments already recorded oldest first, rather than in whatever
-- order Postgres happens to store them (which is what adding a SERIAL column
-- would do), then carry on from the highest number. The sequence has the name
-- Prisma gives an autoincrement column, so the schema reads as SERIAL and
-- shows no drift.
ALTER TABLE "SubscriptionPayment" ADD COLUMN "receiptNo" INTEGER;

UPDATE "SubscriptionPayment" p
SET "receiptNo" = numbered.n
FROM (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS n
  FROM "SubscriptionPayment"
) numbered
WHERE numbered."id" = p."id";

CREATE SEQUENCE "SubscriptionPayment_receiptNo_seq" AS INTEGER OWNED BY "SubscriptionPayment"."receiptNo";
SELECT setval(
  '"SubscriptionPayment_receiptNo_seq"',
  COALESCE((SELECT MAX("receiptNo") FROM "SubscriptionPayment"), 0) + 1,
  false
);

ALTER TABLE "SubscriptionPayment"
  ALTER COLUMN "receiptNo" SET DEFAULT nextval('"SubscriptionPayment_receiptNo_seq"'),
  ALTER COLUMN "receiptNo" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_receiptNo_key" ON "SubscriptionPayment"("receiptNo");
