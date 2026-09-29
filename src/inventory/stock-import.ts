import { looseKey, readAmount, readDate, text } from '../products/product-import';

/**
 * One row of an opening-stock import, read the way a person writes it.
 * The product is named by SKU, barcode or exact name (the first one given);
 * the branch by name, or left blank for the one picked on screen.
 */
const COLUMNS: Record<string, string> = {
  sku: 'sku',
  code: 'sku',
  barcode: 'barcode',
  name: 'name',
  product: 'name',
  productname: 'name',
  store: 'store',
  branch: 'store',
  quantity: 'quantity',
  qty: 'quantity',
  stock: 'quantity',
  costprice: 'cost',
  cost: 'cost',
  batch: 'batchNumber',
  batchnumber: 'batchNumber',
  batchno: 'batchNumber',
  expiry: 'expiryDate',
  expirydate: 'expiryDate',
  serials: 'serials',
  serialnumbers: 'serials',
  imei: 'serials',
};

export interface StockRow {
  sku: string | null;
  barcode: string | null;
  name: string | null;
  store: string | null;
  quantity: number;
  cost: number | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  serials: string[];
}

export function readStockRow(row: Record<string, unknown>): StockRow {
  const cells = new Map<string, string>();
  for (const [header, value] of Object.entries(row)) {
    const key = COLUMNS[looseKey(header)];
    if (key) cells.set(key, text(value));
  }
  const get = (k: string) => cells.get(k) ?? '';

  const sku = get('sku');
  const barcode = get('barcode');
  const name = get('name');
  if (!sku && !barcode && !name) throw new Error('Name the product: SKU, Barcode or Name');

  const q = get('quantity');
  if (!q) throw new Error('Quantity is required');
  const quantity = readAmount(q, 'Quantity');
  if (quantity <= 0) throw new Error('Quantity must be more than 0');

  const cost = get('cost');
  const expiry = get('expiryDate');
  const batch = get('batchNumber');
  if (batch.length > 100) throw new Error('Batch number is longer than 100 characters');
  const serials = get('serials')
    .split(/[|;,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (serials.some((s) => s.length > 64)) throw new Error('A serial number is longer than 64 characters');

  return {
    sku: sku || null,
    barcode: barcode || null,
    name: name || null,
    store: get('store') || null,
    quantity,
    cost: cost ? readAmount(cost, 'Cost') : null,
    batchNumber: batch || null,
    expiryDate: expiry ? readDate(expiry, 'Expiry date') : null,
    serials,
  };
}
