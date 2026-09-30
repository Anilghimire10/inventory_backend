-- Subscription plans: the admin panel sets named plans (a branch limit, and
-- prices for 1 month, 3 months and a year); owners pick one on their
-- Subscription page. A shop remembers its plan, and each payment, report and
-- online payment keeps the plan's name as it was then. Additive.

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "planId" TEXT;

-- AlterTable
ALTER TABLE "PaymentClaim" ADD COLUMN     "planId" TEXT,
ADD COLUMN     "planName" TEXT;

-- AlterTable
ALTER TABLE "SubscriptionPayment" ADD COLUMN     "planName" TEXT;

-- AlterTable
ALTER TABLE "OnlinePayment" ADD COLUMN     "planId" TEXT,
ADD COLUMN     "planName" TEXT;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "plans" JSONB;


-- The online prices already set become one plan, "Standard", with no branch
-- limit, so shops can keep paying what they paid. Lengths other than 1, 3 and
-- 12 months are dropped: plans offer only those.
UPDATE "PlatformSettings"
SET "plans" = jsonb_build_array(jsonb_build_object(
  'id', 'standard',
  'name', 'Standard',
  'description', NULL,
  'features', '[]'::jsonb,
  'maxStores', NULL,
  'prices', (
    SELECT COALESCE(jsonb_agg(p ORDER BY (p->>'months')::int), '[]'::jsonb)
    FROM jsonb_array_elements("onlinePlans") AS p
    WHERE (p->>'months') IN ('1', '3', '12')
  )
))
WHERE jsonb_typeof("onlinePlans") = 'array' AND jsonb_array_length("onlinePlans") > 0;
