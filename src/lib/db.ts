/**
 * D1 query helpers — centralized access to the database
 */

import type { Order, OrderStatus, LineItem } from '../types/api';

// ─── Order queries ──────────────────────────────────────────────

export async function createOrder(db: D1Database, params: {
  id: string;
  orderNumber: string;
  currency: string;
  amount: number;
  customerEmail?: string;
  customerName?: string;
  items: LineItem[];
}): Promise<void> {
  await db.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, customer_name, items_json)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`
  ).bind(
    params.id,
    params.orderNumber,
    params.currency,
    params.amount,
    params.customerEmail ?? null,
    params.customerName ?? null,
    JSON.stringify(params.items),
  ).run();
}

export async function getOrderById(db: D1Database, id: string): Promise<Order | null> {
  const row = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>();
  return row ? rowToOrder(row) : null;
}

export async function getOrderByCheckoutId(db: D1Database, checkoutId: string): Promise<Order | null> {
  const row = await db.prepare('SELECT * FROM orders WHERE verifone_checkout_id = ?').bind(checkoutId).first<OrderRow>();
  return row ? rowToOrder(row) : null;
}

export async function updateOrderStatus(
  db: D1Database,
  id: string,
  status: OrderStatus,
  extra?: { verifoneCheckoutId?: string; verifoneTransactionId?: string; landsbankinnSettlementId?: string; paidAt?: string; settledAt?: string },
): Promise<void> {
  const sets = ['status = ?', 'updated_at = datetime(\'now\')'];
  const binds: (string | number | null)[] = [status];

  if (extra?.verifoneCheckoutId) { sets.push('verifone_checkout_id = ?'); binds.push(extra.verifoneCheckoutId); }
  if (extra?.verifoneTransactionId) { sets.push('verifone_transaction_id = ?'); binds.push(extra.verifoneTransactionId); }
  if (extra?.landsbankinnSettlementId) { sets.push('landsbankinn_settlement_id = ?'); binds.push(extra.landsbankinnSettlementId); }
  if (extra?.paidAt) { sets.push('paid_at = ?'); binds.push(extra.paidAt); }
  if (extra?.settledAt) { sets.push('settled_at = ?'); binds.push(extra.settledAt); }

  binds.push(id);
  await db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
}

// ─── Payment event queries ──────────────────────────────────────

export async function logPaymentEvent(db: D1Database, params: {
  id: string;
  orderId: string;
  eventType: string;
  source: string;
  verifoneEventId?: string;
  rawPayload?: string;
  verified: boolean;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO payment_events (id, order_id, event_type, source, verifone_event_id, raw_payload, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    params.id,
    params.orderId,
    params.eventType,
    params.source,
    params.verifoneEventId ?? null,
    params.rawPayload ?? null,
    params.verified ? 1 : 0,
  ).run();
}

// ─── Webhook idempotency ────────────────────────────────────────

export async function isWebhookProcessed(db: D1Database, eventId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM processed_webhooks WHERE verifone_event_id = ?').bind(eventId).first();
  return row !== null;
}

export async function markWebhookProcessed(db: D1Database, eventId: string, eventType: string): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO processed_webhooks (verifone_event_id, event_type) VALUES (?, ?)'
  ).bind(eventId, eventType).run();
}

// ─── Helpers ────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  currency: string;
  amount: number;
  customer_email: string | null;
  customer_name: string | null;
  items_json: string;
  verifone_checkout_id: string | null;
  verifone_transaction_id: string | null;
  landsbankinn_settlement_id: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  settled_at: string | null;
}

function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id,
    order_number: row.order_number,
    status: row.status as OrderStatus,
    currency: row.currency,
    amount: row.amount,
    customer_email: row.customer_email ?? undefined,
    customer_name: row.customer_name ?? undefined,
    items: JSON.parse(row.items_json),
    verifone_checkout_id: row.verifone_checkout_id ?? undefined,
    verifone_transaction_id: row.verifone_transaction_id ?? undefined,
    landsbankinn_settlement_id: row.landsbankinn_settlement_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_at: row.paid_at ?? undefined,
    settled_at: row.settled_at ?? undefined,
  };
}

// ─── UUID + order number generation ──────────────────────────────

export function generateUUID(): string {
  return crypto.randomUUID();
}

export function generateOrderNumber(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `IRJA-${date}-${random}`;
}
