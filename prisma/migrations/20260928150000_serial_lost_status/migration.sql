-- A serialised unit that left the shelf without being sold: stolen, missing
-- at a stock take, or removed by a manual adjustment. Additive.

-- AlterEnum
ALTER TYPE "SerialStatus" ADD VALUE 'LOST';

