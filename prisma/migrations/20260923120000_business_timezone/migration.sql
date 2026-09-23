-- Business-local day boundaries.
--
-- Every report used to cut its days on the server's UTC midnight, which for a
-- shop in Kathmandu is 05:45 local: sales rung up before quarter to six were
-- filed under the previous day, and the hour-of-day chart was displaced by
-- most of a trading day. Reports now cut on this zone instead.
--
-- Existing rows default to Asia/Kathmandu, which is where every business on
-- the system today trades.
ALTER TABLE "Business"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kathmandu';
