-- migrations/0001_init.sql
-- Irja Payments Gateway — Initial Schema
-- D1 (SQLite) for Cloudflare Workers

-- ─── Orders table: tracks the Irja-side order lifecycle ─────────
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,                        -- UUID v4 (never auto-increment)
    order_number TEXT UNIQUE NOT NULL,          -- Human-readable: IRJA-YYYYMMDD-XXXX
    status TEXT NOT NULL DEFAULT 'pending',     -- pending | checkout_created | payment_pending | paid | failed | refunded | settled
    currency TEXT NOT NULL DEFAULT 'ISK',       -- ISO 4217
    amount INTEGER NOT NULL,                    -- Total in minor units (aurar for ISK)
    customer_email TEXT,
    customer_name TEXT,
    items_json TEXT NOT NULL,                   -- JSON array of line items
    verifone_checkout_id TEXT,                  -- Verifone checkout session ID
    verifone_transaction_id TEXT,               -- Verifone transaction ID (after payment)
    landsbankinn_settlement_id TEXT,            -- Settlement batch ID (after reconciliation)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT,
    settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_checkout_id ON orders(verifone_checkout_id);
CREATE INDEX IF NOT EXISTS idx_orders_transaction_id ON orders(verifone_transaction_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- ─── Payment events audit log: every webhook + API verification ─
CREATE TABLE IF NOT EXISTS payment_events (
    id TEXT PRIMARY KEY,                        -- UUID v4
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL,                   -- checkout_created, transaction_success, transaction_failed, refund_approved, settlement_matched
    source TEXT NOT NULL,                       -- verifone_webhook | verifone_api | landsbankinn_api | manual
    verifone_event_id TEXT,                     -- eventId from webhook payload
    raw_payload TEXT,                            -- Full JSON payload (no card data)
    verified INTEGER NOT NULL DEFAULT 0,        -- 1 = signature verified, 0 = unverified
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE INDEX IF NOT EXISTS idx_events_order_id ON payment_events(order_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON payment_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_verifone_id ON payment_events(verifone_event_id);

-- ─── Idempotency log: prevent duplicate webhook processing ──────
CREATE TABLE IF NOT EXISTS processed_webhooks (
    verifone_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Settlement reconciliation log ──────────────────────────────
CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,                        -- Landsbankinn settlement ID
    settlement_date TEXT NOT NULL,
    total_amount INTEGER NOT NULL,              -- In minor units
    currency TEXT NOT NULL,
    transaction_count INTEGER NOT NULL,
    raw_json TEXT,                              -- Full settlement payload
    reconciled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_settlements_date ON settlements(settlement_date);
