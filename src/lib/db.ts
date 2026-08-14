/**
 * D1 query helpers — centralized access to the database
 */

import type { Order, OrderStatus, LineItem, PaymentMethod } from '../types/api';

// ─── Order queries ──────────────────────────────────────────────

export async function createOrder(
  db: D1Database,
  params: {
    id: string;
    orderNumber: string;
    currency: string;
    amount: number;
    customerEmail?: string;
    customerName?: string;
    items: LineItem[];
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, customer_name, items_json)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.orderNumber,
      params.currency,
      params.amount,
      params.customerEmail ?? null,
      params.customerName ?? null,
      JSON.stringify(params.items),
    )
    .run();
}

export async function getOrderById(db: D1Database, id: string): Promise<Order | null> {
  const row = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<OrderRow>();
  return row ? rowToOrder(row) : null;
}

export async function getOrderByCheckoutId(db: D1Database, checkoutId: string): Promise<Order | null> {
  const row = await db
    .prepare('SELECT * FROM orders WHERE verifone_checkout_id = ?')
    .bind(checkoutId)
    .first<OrderRow>();
  return row ? rowToOrder(row) : null;
}

export async function updateOrderStatus(
  db: D1Database,
  id: string,
  status: OrderStatus,
  extra?: {
    verifoneCheckoutId?: string;
    verifoneTransactionId?: string;
    landsbankinnSettlementId?: string;
    paymentMethod?: PaymentMethod;
    paidAt?: string;
    settledAt?: string;
    allowedFrom?: OrderStatus[];
  },
): Promise<boolean> {
  const sets = ['status = ?', "updated_at = datetime('now')"];
  const binds: (string | number | null)[] = [status];

  if (extra?.verifoneCheckoutId) {
    sets.push('verifone_checkout_id = ?');
    binds.push(extra.verifoneCheckoutId);
  }
  if (extra?.verifoneTransactionId) {
    sets.push('verifone_transaction_id = ?');
    binds.push(extra.verifoneTransactionId);
  }
  if (extra?.landsbankinnSettlementId) {
    sets.push('landsbankinn_settlement_id = ?');
    binds.push(extra.landsbankinnSettlementId);
  }
  if (extra?.paymentMethod) {
    sets.push('payment_method = ?');
    binds.push(extra.paymentMethod);
  }
  if (extra?.paidAt) {
    sets.push('paid_at = ?');
    binds.push(extra.paidAt);
  }
  if (extra?.settledAt) {
    sets.push('settled_at = ?');
    binds.push(extra.settledAt);
  }

  binds.push(id);
  let where = 'id = ?';
  if (extra?.allowedFrom && extra.allowedFrom.length > 0) {
    where += ` AND status IN (${extra.allowedFrom.map(() => '?').join(', ')})`;
    binds.push(...extra.allowedFrom);
  }
  const result = await db
    .prepare(`UPDATE orders SET ${sets.join(', ')} WHERE ${where}`)
    .bind(...binds)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

// ─── Payment event queries ──────────────────────────────────────

export async function logPaymentEvent(
  db: D1Database,
  params: {
    id: string;
    orderId: string;
    eventType: string;
    source: string;
    verifoneEventId?: string;
    rawPayload?: string;
    verified: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payment_events (id, order_id, event_type, source, verifone_event_id, raw_payload, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.orderId,
      params.eventType,
      params.source,
      params.verifoneEventId ?? null,
      params.rawPayload ?? null,
      params.verified ? 1 : 0,
    )
    .run();
}

// ─── Webhook idempotency ────────────────────────────────────────

export async function isWebhookProcessed(db: D1Database, eventId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM processed_webhooks WHERE verifone_event_id = ?').bind(eventId).first();
  return row !== null;
}

export async function markWebhookProcessed(db: D1Database, eventId: string, eventType: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO processed_webhooks (verifone_event_id, event_type) VALUES (?, ?)')
    .bind(eventId, eventType)
    .run();
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
  payment_method: string | null;
  verifone_checkout_id: string | null;
  verifone_transaction_id: string | null;
  landsbankinn_settlement_id: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  settled_at: string | null;
}

const PAYMENT_METHODS: ReadonlySet<PaymentMethod> = new Set(['card', 'paypal', 'apple_pay', 'google_pay', 'unknown']);

function storedPaymentMethod(value: string | null): PaymentMethod {
  return value !== null && PAYMENT_METHODS.has(value as PaymentMethod) ? (value as PaymentMethod) : 'unknown';
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
    payment_method: storedPaymentMethod(row.payment_method),
    verifone_checkout_id: row.verifone_checkout_id ?? undefined,
    verifone_transaction_id: row.verifone_transaction_id ?? undefined,
    landsbankinn_settlement_id: row.landsbankinn_settlement_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    paid_at: row.paid_at ?? undefined,
    settled_at: row.settled_at ?? undefined,
  };
}

// ─── Order-status access capabilities ────────────────────────────

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashAccessToken(token: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

export async function deriveOrderAccessToken(idempotencyKey: string, orderId: string): Promise<string> {
  return hashAccessToken(`order-status-v1\0${idempotencyKey}\0${orderId}`);
}

export function generateOrderAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

export async function createOrderAccessToken(db: D1Database, orderId: string, token: string): Promise<void> {
  await db
    .prepare('INSERT INTO order_access_tokens (order_id, token_hash) VALUES (?, ?)')
    .bind(orderId, await hashAccessToken(token))
    .run();
}

export async function createOrderWithAccessToken(
  db: D1Database,
  params: {
    id: string;
    orderNumber: string;
    currency: string;
    amount: number;
    customerEmail?: string;
    customerName?: string;
    items: LineItem[];
    accessToken: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO orders (id, order_number, status, currency, amount, customer_email, customer_name, items_json)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .bind(
        params.id,
        params.orderNumber,
        params.currency,
        params.amount,
        params.customerEmail ?? null,
        params.customerName ?? null,
        JSON.stringify(params.items),
      ),
    db
      .prepare('INSERT INTO order_access_tokens (order_id, token_hash) VALUES (?, ?)')
      .bind(params.id, await hashAccessToken(params.accessToken)),
  ]);
}

export interface CheckoutAttempt {
  key_hash: string;
  request_hash: string;
  order_id: string;
  status: 'processing' | 'completed' | 'failed';
  checkout_url: string | null;
}

export async function hashIdempotencyValue(value: string): Promise<string> {
  return hashAccessToken(value);
}

export async function claimCheckoutAttempt(
  db: D1Database,
  input: { keyHash: string; requestHash: string; orderId: string },
): Promise<{ claimed: boolean; attempt: CheckoutAttempt }> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO checkout_attempts (key_hash, request_hash, order_id)
     VALUES (?, ?, ?)`,
    )
    .bind(input.keyHash, input.requestHash, input.orderId)
    .run();

  const attempt = await db
    .prepare(
      `SELECT key_hash, request_hash, order_id, status, checkout_url
     FROM checkout_attempts WHERE key_hash = ?`,
    )
    .bind(input.keyHash)
    .first<CheckoutAttempt>();
  if (!attempt) throw new Error('Failed to claim checkout attempt');
  return { claimed: (result.meta.changes ?? 0) === 1, attempt };
}

/** Persist the provider checkout URL as soon as it exists, before any further writes,
 *  so a crash after this point never leaves an in-flight attempt indistinguishable
 *  from one where no provider session was created yet. */
export async function recordCheckoutUrl(db: D1Database, keyHash: string, checkoutUrl: string): Promise<void> {
  await db
    .prepare(
      `UPDATE checkout_attempts SET checkout_url = ?, updated_at = datetime('now')
     WHERE key_hash = ? AND status = 'processing'`,
    )
    .bind(checkoutUrl, keyHash)
    .run();
}

export async function completeCheckoutAttempt(db: D1Database, keyHash: string, checkoutUrl: string): Promise<void> {
  await db
    .prepare(
      `UPDATE checkout_attempts
     SET status = 'completed', checkout_url = ?, updated_at = datetime('now')
     WHERE key_hash = ? AND status = 'processing'`,
    )
    .bind(checkoutUrl, keyHash)
    .run();
}

const STALE_CHECKOUT_ATTEMPT_SECONDS = 45;

/** Reclaim a 'processing' attempt that never got a checkout_url within the lease
 *  window — i.e. the Worker died before any provider session could have been created,
 *  so it is safe to let the caller retry as a fresh claim. Attempts that already have
 *  a checkout_url are never reclaimed, since a provider session may exist for them. */
export async function reclaimStaleCheckoutAttempt(
  db: D1Database,
  input: { keyHash: string; requestHash: string; orderId: string },
): Promise<{ reclaimed: boolean; attempt: CheckoutAttempt }> {
  const result = await db
    .prepare(
      `UPDATE checkout_attempts
     SET request_hash = ?, order_id = ?, status = 'processing', checkout_url = NULL, updated_at = datetime('now')
     WHERE key_hash = ? AND status = 'processing' AND checkout_url IS NULL
       AND updated_at < datetime('now', '-' || ? || ' seconds')`,
    )
    .bind(input.requestHash, input.orderId, input.keyHash, STALE_CHECKOUT_ATTEMPT_SECONDS)
    .run();

  const attempt = await db
    .prepare(
      `SELECT key_hash, request_hash, order_id, status, checkout_url
     FROM checkout_attempts WHERE key_hash = ?`,
    )
    .bind(input.keyHash)
    .first<CheckoutAttempt>();
  if (!attempt) throw new Error('Failed to reclaim checkout attempt');
  return { reclaimed: (result.meta.changes ?? 0) === 1, attempt };
}

export async function failCheckoutAttempt(db: D1Database, keyHash: string): Promise<void> {
  await db
    .prepare(
      `UPDATE checkout_attempts SET status = 'failed', updated_at = datetime('now')
     WHERE key_hash = ? AND status = 'processing'`,
    )
    .bind(keyHash)
    .run();
}

export async function hasOrderAccess(db: D1Database, orderId: string, token: string | undefined): Promise<boolean> {
  if (!token || token.length > 256) return false;
  const row = await db
    .prepare('SELECT token_hash FROM order_access_tokens WHERE order_id = ?')
    .bind(orderId)
    .first<{ token_hash: string }>();
  const expectedHash = row?.token_hash ?? base64Url(new Uint8Array(32));
  const providedHash = await hashAccessToken(token);
  const encoder = new TextEncoder();
  return (
    row !== null &&
    row !== undefined &&
    crypto.subtle.timingSafeEqual(encoder.encode(providedHash), encoder.encode(expectedHash))
  );
}

export interface AtomicWebhookTransition {
  eventId: string;
  eventType: string;
  orderId: string;
  status: 'paid' | 'failed' | 'refunded';
  rawPayload: string;
  verifoneTransactionId?: string;
  paymentMethod?: PaymentMethod;
}

/** Apply the idempotency marker, legal order transition, and audit event in one D1 batch. */
export async function processWebhookAtomically(
  db: D1Database,
  input: AtomicWebhookTransition,
): Promise<'applied' | 'duplicate' | 'illegal_transition'> {
  const eventId = input.eventId;
  const eventInsert = db
    .prepare('INSERT OR IGNORE INTO processed_webhooks (verifone_event_id, event_type) VALUES (?, ?)')
    .bind(eventId, input.eventType);

  // 'paid' includes 'failed' so a verified success can recover an order that a
  // prior unverified/incorrect failure transition already marked failed.
  // 'refunded' includes 'settled' since daily reconciliation moves paid -> settled
  // before a refund webhook may arrive.
  const allowedFrom =
    input.status === 'paid'
      ? "status IN ('pending', 'checkout_created', 'payment_pending', 'failed')"
      : input.status === 'failed'
        ? "status IN ('pending', 'checkout_created', 'payment_pending')"
        : "status IN ('paid', 'settled')";
  const update = db
    .prepare(
      `UPDATE orders SET status = ?, updated_at = datetime('now'),
       paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE paid_at END,
       verifone_transaction_id = COALESCE(?, verifone_transaction_id),
       payment_method = COALESCE(?, payment_method)
     WHERE id = ? AND ${allowedFrom} AND (SELECT changes()) = 1`,
    )
    .bind(input.status, input.status, input.verifoneTransactionId ?? null, input.paymentMethod ?? null, input.orderId);
  const event = db
    .prepare(
      `INSERT INTO payment_events (id, order_id, event_type, source, verifone_event_id, raw_payload, verified)
     SELECT ?, ?, ?, 'verifone_webhook', ?, ?, 1 WHERE changes() = 1`,
    )
    .bind(generateUUID(), input.orderId, input.eventType, eventId, input.rawPayload);

  const results = await db.batch([eventInsert, update, event]);
  if ((results[0].meta.changes ?? 0) === 0) return 'duplicate';
  return (results[1].meta.changes ?? 0) === 1 ? 'applied' : 'illegal_transition';
}

export interface AtomicReturnTransition {
  orderId: string;
  status: 'paid' | 'failed';
  eventType: 'transaction_success' | 'transaction_failed';
  transactionId?: string;
  rawPayload: string;
  paymentMethod?: PaymentMethod;
}

/** Apply a verified browser-return transition and its audit event atomically. */
export async function processReturnAtomically(db: D1Database, input: AtomicReturnTransition): Promise<boolean> {
  // 'paid' includes 'failed' so a verified success can recover an order that a
  // prior unverified/incorrect failure transition already marked failed —
  // mirrors the webhook path in applyWebhookTransition above.
  const allowedFrom =
    input.status === 'paid'
      ? "status IN ('pending', 'checkout_created', 'payment_pending', 'failed')"
      : "status IN ('pending', 'checkout_created', 'payment_pending')";
  const update = db
    .prepare(
      `UPDATE orders SET status = ?, updated_at = datetime('now'),
       paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE paid_at END,
       verifone_transaction_id = COALESCE(?, verifone_transaction_id),
       payment_method = COALESCE(?, payment_method)
     WHERE id = ? AND ${allowedFrom}`,
    )
    .bind(input.status, input.status, input.transactionId ?? null, input.paymentMethod ?? null, input.orderId);
  const event = db
    .prepare(
      `INSERT INTO payment_events (id, order_id, event_type, source, verifone_event_id, raw_payload, verified)
     SELECT ?, ?, ?, 'verifone_return', ?, ?, 1 WHERE changes() = 1`,
    )
    .bind(generateUUID(), input.orderId, input.eventType, input.transactionId ?? null, input.rawPayload);

  const results = await db.batch([update, event]);
  return (results[0].meta.changes ?? 0) === 1;
}

// ─── UUID + order number generation ──────────────────────────────

export function generateUUID(): string {
  return crypto.randomUUID();
}

export function generateOrderNumber(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `IRJA-${date}-${random}`;
}

// ─── Reconciliation queries ──────────────────────────────────────

export interface ReconciliationOrder {
  id: string;
  status: string;
  amount: number;
  currency: string;
  payment_method: string | null;
  verifone_transaction_id: string | null;
  landsbankinn_settlement_id: string | null;
}

export async function getLastCompletedReconciliationDateTo(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT date_to FROM reconciliation_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`)
    .first<{ date_to: string }>();
  return row?.date_to ?? null;
}

export async function startReconciliationRun(
  db: D1Database,
  params: { id: string; startedAt: string; dateFrom: string; dateTo: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reconciliation_runs (id, started_at, date_from, date_to, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .bind(params.id, params.startedAt, params.dateFrom, params.dateTo)
    .run();
}

export async function completeReconciliationRun(
  db: D1Database,
  params: {
    runId: string;
    completedAt: string;
    settlementsProcessed: number;
    transactionsMatched: number;
    transactionsUnmatched: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE reconciliation_runs
         SET status = 'completed', completed_at = ?, settlements_processed = ?,
             transactions_matched = ?, transactions_unmatched = ?
         WHERE id = ? AND status = 'running'`,
    )
    .bind(
      params.completedAt,
      params.settlementsProcessed,
      params.transactionsMatched,
      params.transactionsUnmatched,
      params.runId,
    )
    .run();
}

export async function failReconciliationRun(
  db: D1Database,
  params: { runId: string; completedAt: string; errorName: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE reconciliation_runs
         SET status = 'failed', completed_at = ?, error_name = ?
         WHERE id = ? AND status = 'running'`,
    )
    .bind(params.completedAt, params.errorName, params.runId)
    .run();
}

export async function recordSettlementBatch(
  db: D1Database,
  settlement: { id: string; settlementDate: string; totalAmount: number; currency: string; transactionCount: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO settlements (
        id, settlement_date, total_amount, currency, transaction_count, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      settlement.id,
      settlement.settlementDate,
      settlement.totalAmount,
      settlement.currency,
      settlement.transactionCount,
      JSON.stringify(settlement),
    )
    .run();
}

export async function recordReconciliationException(
  db: D1Database,
  input: {
    runId: string;
    settlementId: string;
    transactionId: string;
    orderId?: string;
    reason: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO reconciliation_exceptions
       (id, run_id, settlement_id, transaction_id, order_id, reason, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      generateUUID(),
      input.runId,
      input.settlementId,
      input.transactionId,
      input.orderId ?? null,
      input.reason,
      JSON.stringify(input.details),
    )
    .run();
}

export async function getOrderByOrderNumber(db: D1Database, orderNumber: string): Promise<ReconciliationOrder | null> {
  const row = await db
    .prepare(
      `SELECT id, status, amount, currency, payment_method, verifone_transaction_id, landsbankinn_settlement_id
       FROM orders WHERE order_number = ?`,
    )
    .bind(orderNumber)
    .first<ReconciliationOrder>();
  return row ?? null;
}

/** Conditionally transition a verified `paid` order to `settled` and log the audit
 *  event in one D1 batch. Returns whether this call performed the transition. */
export async function settleOrderAtomically(
  db: D1Database,
  params: {
    orderId: string;
    settlementId: string;
    settledAt: string;
    transactionAmount: number;
    transactionCurrency: string;
    auditPayload: string;
  },
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE orders
         SET status = 'settled', landsbankinn_settlement_id = ?,
             settled_at = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'paid' AND amount = ? AND currency = ?
           AND verifone_transaction_id IS NOT NULL`,
      )
      .bind(
        params.settlementId,
        params.settledAt,
        params.orderId,
        params.transactionAmount,
        params.transactionCurrency,
      ),
    db
      .prepare(
        `INSERT INTO payment_events (
          id, order_id, event_type, source, raw_payload, verified
        )
         SELECT ?, ?, 'settlement_matched', 'landsbankinn_api', ?, 1
         WHERE changes() = 1`,
      )
      .bind(generateUUID(), params.orderId, params.auditPayload),
  ]);
  return (results[0].meta.changes ?? 0) === 1;
}
