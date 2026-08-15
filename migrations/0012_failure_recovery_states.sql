-- migrations/0012_failure_recovery_states.sql
-- Enhanced order states and dead letter queue for failure recovery.
-- Adds support for PENDING_CUSTOMER_DATA, QUEUED_FOR_SEQUENCING, and SETTLED_PENDING_INVOICE states.

-- ─── Extend order status enum (drop and recreate triggers) ───────
DROP TRIGGER IF EXISTS validate_orders_before_insert;

DROP TRIGGER IF EXISTS validate_orders_before_update;

-- Recreate triggers with expanded status validation
CREATE TRIGGER validate_orders_before_insert
BEFORE INSERT ON orders
WHEN NEW.status NOT IN ('pending', 'checkout_created', 'payment_pending', 'paid', 'failed', 'refunded', 'settled', 'PENDING_CUSTOMER_DATA', 'QUEUED_FOR_SEQUENCING', 'SETTLED_PENDING_INVOICE')
  OR NEW.amount <= 0
  OR length(NEW.currency) <> 3
  OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]'
BEGIN
  SELECT RAISE(ABORT, 'invalid order state or monetary fields');
END;

CREATE TRIGGER validate_orders_before_update
BEFORE UPDATE OF status, amount, currency ON orders
WHEN NEW.status NOT IN ('pending', 'checkout_created', 'payment_pending', 'paid', 'failed', 'refunded', 'settled', 'PENDING_CUSTOMER_DATA', 'QUEUED_FOR_SEQUENCING', 'SETTLED_PENDING_INVOICE')
  OR NEW.amount <= 0
  OR length(NEW.currency) <> 3
  OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]'
BEGIN
  SELECT RAISE(ABORT, 'invalid order state or monetary fields');
END;

-- ─── Dead Letter Queue table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS dead_letter_events (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    original_payload TEXT NOT NULL,
    error_message TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    last_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'queued',
    resolved_at TEXT,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    CHECK (event_type IN ('vat_computation_failed', 'peppol_submission_failed', 'validator_timeout', 'invoice_generation_failed')),
    CHECK (status IN ('queued', 'retrying', 'failed', 'resolved')),
    CHECK (retry_count >= 0),
    CHECK (retry_count <= max_retries)
);

CREATE INDEX IF NOT EXISTS idx_dlq_status_created ON dead_letter_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_dlq_order_id ON dead_letter_events(order_id);
CREATE INDEX IF NOT EXISTS idx_dlq_event_type ON dead_letter_events(event_type);

-- ─── Sequence queue table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sequence_queue (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    sequence_type TEXT NOT NULL,
    year INTEGER NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'queued',
    processed_at TEXT,
    sequence_number INTEGER,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    CHECK (sequence_type IN ('invoice', 'credit_note')),
    CHECK (priority IN ('normal', 'high')),
    CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    UNIQUE (order_id, sequence_type)
);

CREATE INDEX IF NOT EXISTS idx_seq_queue_status_priority ON sequence_queue(status, priority, requested_at);
CREATE INDEX IF NOT EXISTS idx_seq_queue_type_year ON sequence_queue(sequence_type, year);

-- ─── Document classification tracking ─────────────────────────────
-- Add columns to orders table for document type tracking
ALTER TABLE orders ADD COLUMN document_type TEXT DEFAULT 'sölureikningur'
  CHECK (document_type IN ('sölureikningur', 'sölukvittun'));

ALTER TABLE orders ADD COLUMN classification_reason TEXT;

-- Index for document type reporting
CREATE INDEX IF NOT EXISTS idx_orders_document_type ON orders(document_type);

-- ─── Payment reconciliation audit ────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_reconciliation (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    cart_total INTEGER NOT NULL,
    gateway_authorized INTEGER NOT NULL,
    discrepancy INTEGER NOT NULL,
    reconciliation_status TEXT NOT NULL,
    adjustment_applied INTEGER DEFAULT 0,
    adjustment_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    CHECK (reconciliation_status IN ('exact_match', 'rounding_adjusted', 'TRANSACTION_ABORTED_PRICE_MISMATCH')),
    UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_status ON payment_reconciliation(reconciliation_status);