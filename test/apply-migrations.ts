/**
 * Apply D1 migrations for tests.
 *
 * We inline the migration SQL rather than using `readD1Migrations()` from
 * `@cloudflare/vitest-pool-workers/config`, because that helper pulls in
 * `node:fs/promises` at module-load time and the setup file executes inside
 * the Workers runtime where that built-in is unavailable.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Copy of migrations/0001_init.sql — kept in sync manually
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_number TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    currency TEXT NOT NULL DEFAULT 'ISK',
    amount INTEGER NOT NULL,
    customer_email TEXT,
    customer_name TEXT,
    items_json TEXT NOT NULL,
    verifone_checkout_id TEXT,
    verifone_transaction_id TEXT,
    landsbankinn_settlement_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT,
    settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_checkout_id ON orders(verifone_checkout_id);
CREATE INDEX IF NOT EXISTS idx_orders_transaction_id ON orders(verifone_transaction_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE TABLE IF NOT EXISTS payment_events (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    verifone_event_id TEXT,
    raw_payload TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS idx_events_order_id ON payment_events(order_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON payment_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_verifone_id ON payment_events(verifone_event_id);
CREATE TABLE IF NOT EXISTS processed_webhooks (
    verifone_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    settlement_date TEXT NOT NULL,
    total_amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    transaction_count INTEGER NOT NULL,
    raw_json TEXT,
    reconciled_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_settlements_date ON settlements(settlement_date);
`;

// Split on semicolons, filter empty statements
function splitSql(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ';');
}

beforeAll(async () => {
  const migrations = [
    { name: '0001_init.sql', queries: splitSql(MIGRATION_SQL) },
  ];
  await applyD1Migrations(env.DB, migrations);
});
