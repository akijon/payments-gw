-- Durable reconciliation cursor and run history.
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
