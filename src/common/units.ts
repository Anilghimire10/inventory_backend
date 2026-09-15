export const DISCRETE_UNITS = ["pcs", "box", "pkt", "dozen", "pair"] as const;
export const FRACTIONAL_UNITS = ["kg", "g", "l", "ml", "m", "ft"] as const;
export const UNITS: string[] = [...DISCRETE_UNITS, ...FRACTIONAL_UNITS];

const FRACTIONAL = new Set<string>(FRACTIONAL_UNITS);

const SYNONYMS: Record<string, string> = {
  piece: "pcs",
  pieces: "pcs",
  pc: "pcs",
  pcs: "pcs",
  unit: "pcs",
  units: "pcs",
  nos: "pcs",
  no: "pcs",
  each: "pcs",
  ea: "pcs",
  packet: "pkt",
  packets: "pkt",
  pkts: "pkt",
  pack: "pkt",
  packs: "pkt",
  boxes: "box",
  carton: "box",
  cartons: "box",
  ctn: "box",
  doz: "dozen",
  dzn: "dozen",
  dozens: "dozen",
  pairs: "pair",
  kilo: "kg",
  kilos: "kg",
  kgs: "kg",
  kilogram: "kg",
  kilograms: "kg",
  gram: "g",
  grams: "g",
  gm: "g",
  gms: "g",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ltr: "l",
  lt: "l",
  millilitre: "ml",
  millilitres: "ml",
  milliliter: "ml",
  milliliters: "ml",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  mtr: "m",
  foot: "ft",
  feet: "ft",
  fts: "ft",
};

export function normalizeUnit(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const canonical = SYNONYMS[v] ?? v;
  return UNITS.includes(canonical) ? canonical : null;
}

export const allowsFraction = (unit: unknown): boolean => {
  const u = normalizeUnit(unit);
  return u !== null && FRACTIONAL.has(u);
};
