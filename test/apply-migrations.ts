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

// Copy of migrations/0001_init.sql + 0002_products.sql — keep in sync manually
const MIGRATION_0001 = `
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

const MIGRATION_0002 = `
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    unit_price INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'ISK',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (unit_price > 0),
    CHECK (active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);
INSERT OR IGNORE INTO products (id, name, description, unit_price, currency, active) VALUES
    ('HOODIE-BLK-M',  'Black Hoodie M',           'Black cotton hoodie, size M',           8900,  'ISK', 1),
    ('TSHIRT-WHT-L',  'White T-Shirt L',          'White cotton t-shirt, size L',          4500,  'ISK', 1),
    ('JEANS-BLUE-32', 'Blue Jeans 32',             'Blue denim jeans, waist 32',            12000, 'ISK', 1),
    ('LOPAPEYSA-M',    'Lopapeysa M',               'Traditional Icelandic wool sweater, M', 18000, 'ISK', 1),
    ('LOPAPEYSA-L',    'Lopapeysa L',               'Traditional Icelandic wool sweater, L', 18000, 'ISK', 1),
    ('WOOL-SCARF',    'Wool Scarf',                'Hand-knit Icelandic wool scarf',         7500,  'ISK', 1),
    ('WOOL-HAT',      'Wool Hat',                  'Icelandic wool beanie',                  4500,  'ISK', 1),
    ('TEST-001',      'Test Product',              'Catalog entry for integration tests',    1000,  'ISK', 1);
`;

const MIGRATION_0003 = `
CREATE TABLE IF NOT EXISTS order_access_tokens (
    order_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);
`;

const MIGRATION_0004 = `
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
`;

const MIGRATION_0005_QUERIES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_verifone_checkout_id
   ON orders(verifone_checkout_id) WHERE verifone_checkout_id IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_verifone_transaction_id
   ON orders(verifone_transaction_id) WHERE verifone_transaction_id IS NOT NULL;`,
  `CREATE TRIGGER IF NOT EXISTS validate_orders_before_insert
   BEFORE INSERT ON orders
   WHEN NEW.status NOT IN ('pending', 'checkout_created', 'payment_pending', 'paid', 'failed', 'refunded', 'settled')
     OR NEW.amount <= 0
     OR length(NEW.currency) <> 3
     OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]'
   BEGIN
     SELECT RAISE(ABORT, 'invalid order state or monetary fields');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS validate_orders_before_update
   BEFORE UPDATE OF status, amount, currency ON orders
   WHEN NEW.status NOT IN ('pending', 'checkout_created', 'payment_pending', 'paid', 'failed', 'refunded', 'settled')
     OR NEW.amount <= 0
     OR length(NEW.currency) <> 3
     OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]'
   BEGIN
     SELECT RAISE(ABORT, 'invalid order state or monetary fields');
   END;`,
];

const MIGRATION_0006 = `
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    status TEXT NOT NULL,
    settlements_processed INTEGER NOT NULL DEFAULT 0,
    transactions_matched INTEGER NOT NULL DEFAULT 0,
    transactions_unmatched INTEGER NOT NULL DEFAULT 0,
    error_name TEXT,
    CHECK (status IN ('running', 'completed', 'failed')),
    CHECK (settlements_processed >= 0),
    CHECK (transactions_matched >= 0),
    CHECK (transactions_unmatched >= 0)
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_completed
ON reconciliation_runs(status, completed_at DESC);
CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    settlement_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    order_id TEXT,
    reason TEXT NOT NULL,
    details_json TEXT NOT NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (settlement_id, transaction_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_unresolved
ON reconciliation_exceptions(resolved_at, created_at);
`;

const MIGRATION_0007 = `
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
`;

const MIGRATION_0008 = `
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'
  CHECK (payment_method IN ('card', 'paypal', 'apple_pay', 'google_pay', 'unknown'));
CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method);
`;

const MIGRATION_0009 = `
ALTER TABLE products ADD COLUMN vat_rate INTEGER NOT NULL DEFAULT 24
  CHECK (vat_rate IN (0, 11, 24));
ALTER TABLE orders ADD COLUMN buyer_kennitala TEXT;
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    invoice_number TEXT NOT NULL UNIQUE,
    issue_date TEXT NOT NULL,
    due_date TEXT,
    delivery_date TEXT,
    buyer_kennitala TEXT,
    status TEXT NOT NULL DEFAULT 'issued',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    CHECK (status IN ('issued', 'void', 'corrected'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);
CREATE TABLE IF NOT EXISTS invoice_sequence (
    year INTEGER PRIMARY KEY,
    next_number INTEGER NOT NULL DEFAULT 1
);
`;

function splitSql(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ';');
}

beforeAll(async () => {
  const migrations = [
    { name: '0001_init.sql', queries: splitSql(MIGRATION_0001) },
    { name: '0002_products.sql', queries: splitSql(MIGRATION_0002) },
    { name: '0003_order_access_tokens.sql', queries: splitSql(MIGRATION_0003) },
    { name: '0004_checkout_idempotency.sql', queries: splitSql(MIGRATION_0004) },
    { name: '0005_order_invariants.sql', queries: MIGRATION_0005_QUERIES },
    { name: '0006_reconciliation_runs.sql', queries: splitSql(MIGRATION_0006) },
    { name: '0007_order_number_index.sql', queries: splitSql(MIGRATION_0007) },
    { name: '0008_payment_method.sql', queries: splitSql(MIGRATION_0008) },
    { name: '0009_invoice_tables.sql', queries: splitSql(MIGRATION_0009) },
  ];
  await applyD1Migrations(env.DB, migrations);
});
