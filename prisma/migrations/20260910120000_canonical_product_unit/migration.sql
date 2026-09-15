-- Product.unit was free text, so "kg", "Kg" and "kilo" were three different
-- units and nothing could tell a weighed product from a discrete one. Fold the
-- spellings people actually type onto a canonical set, then constrain the
-- column so it stays that way.

UPDATE "Product"
SET "unit" = CASE lower(btrim("unit"))
  WHEN 'piece' THEN 'pcs' WHEN 'pieces' THEN 'pcs' WHEN 'pc' THEN 'pcs'
  WHEN 'unit' THEN 'pcs'  WHEN 'units' THEN 'pcs'  WHEN 'nos' THEN 'pcs'
  WHEN 'no' THEN 'pcs'    WHEN 'each' THEN 'pcs'   WHEN 'ea' THEN 'pcs'
  WHEN 'packet' THEN 'pkt' WHEN 'packets' THEN 'pkt' WHEN 'pkts' THEN 'pkt'
  WHEN 'pack' THEN 'pkt'   WHEN 'packs' THEN 'pkt'
  WHEN 'boxes' THEN 'box'  WHEN 'carton' THEN 'box' WHEN 'cartons' THEN 'box'
  WHEN 'ctn' THEN 'box'
  WHEN 'doz' THEN 'dozen'  WHEN 'dzn' THEN 'dozen'  WHEN 'dozens' THEN 'dozen'
  WHEN 'pairs' THEN 'pair'
  WHEN 'kilo' THEN 'kg'    WHEN 'kilos' THEN 'kg'   WHEN 'kgs' THEN 'kg'
  WHEN 'kilogram' THEN 'kg' WHEN 'kilograms' THEN 'kg'
  WHEN 'gram' THEN 'g'     WHEN 'grams' THEN 'g'    WHEN 'gm' THEN 'g'
  WHEN 'gms' THEN 'g'
  WHEN 'litre' THEN 'l'    WHEN 'litres' THEN 'l'   WHEN 'liter' THEN 'l'
  WHEN 'liters' THEN 'l'   WHEN 'ltr' THEN 'l'      WHEN 'lt' THEN 'l'
  WHEN 'millilitre' THEN 'ml' WHEN 'millilitres' THEN 'ml'
  WHEN 'milliliter' THEN 'ml' WHEN 'milliliters' THEN 'ml'
  WHEN 'meter' THEN 'm'    WHEN 'meters' THEN 'm'   WHEN 'metre' THEN 'm'
  WHEN 'metres' THEN 'm'   WHEN 'mtr' THEN 'm'
  WHEN 'foot' THEN 'ft'    WHEN 'feet' THEN 'ft'    WHEN 'fts' THEN 'ft'
  ELSE lower(btrim("unit"))
END;

-- Anything still unrecognised is far more likely to be a thing than a weight,
-- so it lands on pcs rather than silently keeping fractional selling.
UPDATE "Product"
SET "unit" = 'pcs'
WHERE "unit" NOT IN ('pcs','box','pkt','dozen','pair','kg','g','l','ml','m','ft');

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_unit_check"
  CHECK ("unit" IN ('pcs','box','pkt','dozen','pair','kg','g','l','ml','m','ft'));
