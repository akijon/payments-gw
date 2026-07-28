-- Checkout request idempotency prevents double-clicks and network retries from creating duplicate HPP sessions.
CREATE TABLE IF NOT EXISTS checkout_attempts (
    key_hash TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    order_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    checkout_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (status IN ('processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_checkout_attempts_order_id ON checkout_attempts(order_id);
