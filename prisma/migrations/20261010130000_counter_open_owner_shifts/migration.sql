-- An owner's or manager's shift open when counters arrived was left on no
-- counter, so its drawer read as free and a second shift could open on it.
-- Where the store has a single counter, that drawer is the counter's: attach
-- the shift, unless someone already has the counter open. With several
-- counters which one it was is unknown; it takes a counter when the owner
-- next opens one (see ShiftsService.open).
WITH single AS (
  SELECT c.id AS counter_id, c."storeId"
  FROM "Counter" c
  WHERE c."isActive"
    AND (SELECT count(*) FROM "Counter" x WHERE x."storeId" = c."storeId") = 1
    AND NOT EXISTS (
      SELECT 1 FROM "Shift" s WHERE s."counterId" = c.id AND s."closedAt" IS NULL
    )
),
pick AS (
  -- One per counter: the partial unique index allows one open shift on it.
  SELECT DISTINCT ON (s."storeId") s.id AS shift_id, single.counter_id
  FROM "Shift" s
  JOIN single ON single."storeId" = s."storeId"
  WHERE s."closedAt" IS NULL AND s."counterId" IS NULL
  ORDER BY s."storeId", s."openedAt"
)
UPDATE "Shift" s
SET "counterId" = pick.counter_id
FROM pick
WHERE s.id = pick.shift_id;
