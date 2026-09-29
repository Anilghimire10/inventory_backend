import { normalizeUnit, UNITS } from '../common/units';

/**
 * Reading one row of a product import (CSV / Excel), the way a shop owner
 * writes it rather than the way a program would.
 *
 * - Column names are matched loosely: "Selling Price", "selling_price" and
 *   "sellingPrice" are the same column, and a few everyday words work too
 *   ("price", "cost", "category").
 * - A blank cell means "not given": leave the product's value alone on an
 *   update, use the default on a new product. It never means 0.
 * - Amounts may be written "1,200", "Rs 1,200.50" or "NPR 450".
 * - Anything that can't be read throws, naming the column and the value, so
 *   the row is reported instead of imported wrong.
 */

const ALIASES: Record<string, string> = {
  name: 'name',
  productname: 'name',
  product: 'name',
  sku: 'sku',
  code: 'sku',
  barcode: 'barcode',
  brand: 'brand',
  description: 'description',
  unit: 'unit',
  costprice: 'costPrice',
  cost: 'costPrice',
  sellingprice: 'sellingPrice',
  price: 'sellingPrice',
  saleprice: 'sellingPrice',
  mrp: 'sellingPrice',
  taxrate: 'taxRate',
  tax: 'taxRate',
  vat: 'taxRate',
  reorderlevel: 'reorderLevel',
  minimumstock: 'reorderLevel',
  minstock: 'reorderLevel',
  categories: 'categories',
  category: 'categories',
  taxable: 'isTaxable',
  istaxable: 'isTaxable',
  prescription: 'isRxRequired',
  rxrequired: 'isRxRequired',
  isrxrequired: 'isRxRequired',
  expirydate: 'expiryDate',
  expiry: 'expiryDate',
  trackbatches: 'trackBatches',
  batches: 'trackBatches',
  trackserials: 'trackSerials',
  serials: 'trackSerials',
};

/** A column heading reduced to letters: "Selling Price" and "selling_price" match. */
export const looseKey = (header: string) => header.toLowerCase().replace(/[\s_\-.]/g, '');
const keyOf = (header: string) => ALIASES[looseKey(header)];

/**
 * A cell as trimmed text, '' when empty. An export neutralises a cell that
 * would run as a spreadsheet formula by putting an apostrophe in front
 * ("'=x"); that apostrophe is taken back off here.
 */
export function text(v: unknown): string {
  let s: string;
  if (typeof v === 'string') s = v.trim();
  else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
  else return '';
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

/** "1,200", "Rs 1,200.50", "NPR 450" -> a non-negative number. */
export function readAmount(raw: string, column: string): number {
  const s = raw
    .replace(/[\s,]/g, '')
    .replace(/^(rs\.?|npr|inr|usd|रु\.?|\$|₹)/i, '')
    .replace(/(rs|npr)\.?$/i, '');
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`${column} "${raw}" is not a number`);
  }
  return Number(s);
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);
function readYesNo(raw: string, column: string): boolean {
  const v = raw.toLowerCase();
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  throw new Error(`${column} "${raw}" should be yes or no`);
}

/** 2026-12-31 or 2026/12/31 -> midnight UTC of that day. */
export function readDate(raw: string, column: string): Date {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!d || d.getUTCMonth() !== Number(m![2]) - 1) {
    throw new Error(`${column} "${raw}" should be a date like 2026-12-31`);
  }
  return d;
}

const LIMITS: Record<string, number> = { name: 200, sku: 100, barcode: 100, brand: 200, description: 1000 };

/** The column headings people see (and the template uses), for error messages. */
const LABEL: Record<string, string> = {
  name: 'Name',
  sku: 'SKU',
  barcode: 'Barcode',
  brand: 'Brand',
  description: 'Description',
  unit: 'Unit',
  costPrice: 'Cost price',
  sellingPrice: 'Selling price',
  taxRate: 'Tax rate',
  reorderLevel: 'Minimum stock',
  isTaxable: 'Taxable',
  isRxRequired: 'Prescription',
  trackBatches: 'Track batches',
  trackSerials: 'Track serials',
  expiryDate: 'Expiry date',
  categories: 'Categories',
};

export function readProductRow(row: Record<string, unknown>) {
  const cells = new Map<string, string>();
  for (const [header, value] of Object.entries(row)) {
    const key = keyOf(header);
    if (key) cells.set(key, text(value));
  }
  const get = (key: string) => {
    const v = cells.get(key) ?? '';
    const max = LIMITS[key];
    if (max && v.length > max) throw new Error(`${LABEL[key]} is longer than ${max} characters`);
    return v;
  };

  const fields: {
    name?: string;
    barcode?: string | null;
    brand?: string | null;
    description?: string | null;
    unit?: string;
    costPrice?: number;
    sellingPrice?: number;
    taxRate?: number;
    reorderLevel?: number;
    isTaxable?: boolean;
    isRxRequired?: boolean;
    expiryDate?: Date | null;
    trackBatches?: boolean;
    trackSerials?: boolean;
  } = {};

  const name = get('name');
  if (name) fields.name = name;
  for (const key of ['barcode', 'brand', 'description'] as const) {
    const v = get(key);
    if (v) fields[key] = v;
  }

  const unit = get('unit');
  if (unit) {
    const u = normalizeUnit(unit);
    if (!u) throw new Error(`Unit "${unit}" isn't one the app knows (use one of: ${UNITS.join(', ')})`);
    fields.unit = u;
  }

  for (const key of ['costPrice', 'sellingPrice', 'taxRate', 'reorderLevel'] as const) {
    const v = get(key);
    if (!v) continue;
    const n = readAmount(v, LABEL[key]);
    if (key === 'taxRate' && n > 100) throw new Error(`Tax rate "${v}" should be a percent from 0 to 100`);
    fields[key] = key === 'reorderLevel' ? Math.round(n) : n;
  }

  for (const key of ['isTaxable', 'isRxRequired', 'trackBatches', 'trackSerials'] as const) {
    const v = get(key);
    if (v) fields[key] = readYesNo(v, LABEL[key]);
  }
  if (fields.trackBatches && fields.trackSerials) {
    throw new Error('A product is tracked by batches or by serial numbers, not both');
  }

  const expiry = get('expiryDate');
  if (expiry) fields.expiryDate = readDate(expiry, 'Expiry date');

  // "Rice|Staples" or "Rice; Staples". A blank cell leaves categories alone.
  const cat = get('categories');
  const categories = cat
    ? [...new Set(cat.split(/[|;]/).map((c) => c.trim()).filter(Boolean))]
    : undefined;
  if (categories?.some((c) => c.length > 100)) throw new Error('A category name is longer than 100 characters');

  const sku = get('sku');
  return { sku: sku || null, barcode: fields.barcode ?? null, fields, categories };
}
