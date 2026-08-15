/**
 * Server-side product catalog — authoritative pricing.
 *
 * Client may only send product_id (or sku alias) + quantity.
 * unit_price / total_amount from the client are never trusted.
 */

import type { VatLineItem } from '../types/invoice';

export interface Product {
  id: string;
  name: string;
  description?: string;
  unit_price: number; // minor units
  currency: string;
  active: boolean;
  vat_rate: number; // 24, 11, or 0
}

export interface CheckoutRequestItem {
  /** Preferred client field */
  product_id?: string;
  /** Accepted alias for product_id (legacy / storefront SKU field) */
  sku?: string;
  quantity: number;
  /** Forbidden — presence is a security rejection */
  unit_price?: unknown;
  /** Forbidden — presence is a security rejection */
  total_amount?: unknown;
  name?: unknown;
}

export class CatalogError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'price_manipulation'
      | 'inconsistent_pricing'
      | 'unknown_product'
      | 'invalid_quantity'
      | 'invalid_item'
      | 'mixed_currency'
      | 'empty_cart'
      | 'too_many_items',
    public readonly status: 400 = 400,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

const PRODUCT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LINE_ITEMS = 50;
const MAX_QUANTITY_PER_LINE = 99;

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  unit_price: number;
  currency: string;
  active: number;
  vat_rate: number;
}

export async function getProduct(db: D1Database, productId: string): Promise<Product | null> {
  const row = await db
    .prepare('SELECT id, name, description, unit_price, currency, active, vat_rate FROM products WHERE id = ?')
    .bind(productId)
    .first<ProductRow>();

  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    unit_price: row.unit_price,
    currency: row.currency,
    active: row.active === 1,
    vat_rate: row.vat_rate,
  };
}

export async function getProductsByIds(db: D1Database, productIds: string[]): Promise<Map<string, Product>> {
  const unique = [...new Set(productIds)];
  const map = new Map<string, Product>();
  if (unique.length === 0) return map;

  const placeholders = unique.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT id, name, description, unit_price, currency, active, vat_rate FROM products WHERE id IN (${placeholders})`,
    )
    .bind(...unique)
    .all<ProductRow>();
  for (const row of result.results) {
    map.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      unit_price: row.unit_price,
      currency: row.currency,
      active: row.active === 1,
      vat_rate: row.vat_rate,
    });
  }
  return map;
}

/**
 * Resolve client cart lines against the catalog.
 * Throws CatalogError on any client price control or invalid input.
 */
export async function resolveCheckoutItems(
  db: D1Database,
  rawItems: unknown,
): Promise<{ items: VatLineItem[]; totalAmount: number; currency: string }> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new CatalogError('items is required and must be a non-empty array', 'empty_cart');
  }

  if (rawItems.length > MAX_LINE_ITEMS) {
    throw new CatalogError(`Too many items (max ${MAX_LINE_ITEMS})`, 'too_many_items');
  }

  const requestItems: CheckoutRequestItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CatalogError(`Invalid item at index ${i}: must be an object`, 'invalid_item');
    }
    requestItems.push(item as CheckoutRequestItem);
  }

  // ── Security: reject any client-controlled money fields ─────────
  for (let i = 0; i < requestItems.length; i++) {
    const item = requestItems[i];
    const hasUnit =
      Object.prototype.hasOwnProperty.call(item, 'unit_price') &&
      item.unit_price !== undefined &&
      item.unit_price !== null;
    const hasTotal =
      Object.prototype.hasOwnProperty.call(item, 'total_amount') &&
      item.total_amount !== undefined &&
      item.total_amount !== null;

    if (hasUnit && hasTotal) {
      const unit = Number(item.unit_price);
      const total = Number(item.total_amount);
      const qty = Number(item.quantity);
      if (
        Number.isFinite(unit) &&
        Number.isFinite(total) &&
        Number.isFinite(qty) &&
        qty > 0 &&
        Math.trunc(unit) * Math.trunc(qty) !== Math.trunc(total)
      ) {
        throw new CatalogError(
          'inconsistent pricing: unit_price × quantity does not match total_amount',
          'inconsistent_pricing',
        );
      }
    }

    if (hasUnit || hasTotal) {
      throw new CatalogError(
        'price manipulation rejected: client-controlled unit_price/total_amount are not allowed; send product_id and quantity only',
        'price_manipulation',
      );
    }
  }

  for (let i = 0; i < requestItems.length; i++) {
    const allowedFields = new Set(['product_id', 'sku', 'quantity']);
    const unexpectedField = Object.keys(requestItems[i]).find((field) => !allowedFields.has(field));
    if (unexpectedField) {
      throw new CatalogError(`Invalid item field '${unexpectedField}' at index ${i}`, 'invalid_item');
    }
  }

  // ── Validate identifiers + quantities, resolve products ─────────
  const productIds: string[] = [];
  const quantities = new Map<string, number>();

  for (let i = 0; i < requestItems.length; i++) {
    const item = requestItems[i];
    const productIdRaw = item.product_id ?? item.sku;

    if (
      typeof item.product_id === 'string' &&
      typeof item.sku === 'string' &&
      item.product_id.trim() !== item.sku.trim()
    ) {
      throw new CatalogError(`product_id and sku disagree at item index ${i}`, 'invalid_item');
    }

    if (typeof productIdRaw !== 'string' || productIdRaw.trim() === '') {
      throw new CatalogError(`Invalid item at index ${i}: product_id (or sku) is required`, 'invalid_item');
    }

    const productId = productIdRaw.trim();
    if (!PRODUCT_ID_RE.test(productId)) {
      throw new CatalogError(`Invalid product SKU format at index ${i}`, 'invalid_item');
    }

    if (
      typeof item.quantity !== 'number' ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0 ||
      item.quantity > MAX_QUANTITY_PER_LINE
    ) {
      throw new CatalogError(
        `Invalid quantity at index ${i}: must be an integer from 1 to ${MAX_QUANTITY_PER_LINE}`,
        'invalid_quantity',
      );
    }

    const combinedQuantity = (quantities.get(productId) ?? 0) + item.quantity;
    if (combinedQuantity > MAX_QUANTITY_PER_LINE) {
      throw new CatalogError(`Total quantity for ${productId} exceeds ${MAX_QUANTITY_PER_LINE}`, 'invalid_quantity');
    }
    if (!quantities.has(productId)) productIds.push(productId);
    quantities.set(productId, combinedQuantity);
  }

  const catalog = await getProductsByIds(db, productIds);
  const lineItems: VatLineItem[] = [];
  let totalAmount = 0;
  let currency: string | undefined;

  for (const [productId, quantity] of quantities) {
    const product = catalog.get(productId);
    if (!product || !product.active) {
      throw new CatalogError(`Unknown product SKU: ${productId}`, 'unknown_product');
    }

    if (product.unit_price <= 0 || !Number.isInteger(product.unit_price)) {
      throw new CatalogError(`Catalog misconfiguration for ${productId}`, 'invalid_item');
    }

    if (currency === undefined) {
      currency = product.currency;
    } else if (currency !== product.currency) {
      throw new CatalogError('All checkout items must use the same currency', 'mixed_currency');
    }
    const lineTotal = product.unit_price * quantity;

    // Overflow guard (JS safe integer)
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(totalAmount + lineTotal)) {
      throw new CatalogError('Order total exceeds safe integer range', 'invalid_item');
    }

    totalAmount += lineTotal;
    lineItems.push({
      product_id: product.id,
      name: product.name,
      quantity,
      unit_price: product.unit_price,
      total_amount: lineTotal,
      sku: product.id,
      vat_rate: product.vat_rate as VatLineItem['vat_rate'],
    });
  }

  if (totalAmount <= 0 || currency === undefined) {
    throw new CatalogError('Total amount must be positive', 'invalid_item');
  }

  return { items: lineItems, totalAmount, currency };
}
