-- migrations/0013_incident_tracking.sql
-- Incident tracking for payment processing failures and recovery actions.
-- Provides structured observability for Skatturinn compliance audits.

CREATE TABLE IF NOT EXISTS incidents (
    incident_id TEXT PRIMARY KEY,                    -- INC-YYYY-NNNN format
    source_event TEXT NOT NULL,                      -- ORDER_PAYMENT_SETTLED, etc.
    order_id TEXT NOT NULL,                          -- References orders(id)
    failure_type TEXT NOT NULL,                      -- INVOICE_SEQUENCE_RACE_CONDITION, etc.
    severity TEXT NOT NULL,                          -- LOW | MEDIUM | HIGH | CRITICAL_BLOCKED
    action_taken_json TEXT NOT NULL,                 -- JSON: settlement_status, invoice_status, etc.
    audit_trail_json TEXT NOT NULL,                  -- JSON: reason_code, detail, customer_notified
    created_at_utc TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at_utc TEXT,                            -- NULL while active
    resolution_json TEXT,                            -- JSON: resolved_by, detail, invoice_number
    FOREIGN KEY (order_id) REFERENCES orders(id),
    CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL_BLOCKED')),
    CHECK (failure_type IN (
        'INVOICE_SEQUENCE_RACE_CONDITION',
        'VERIFONE_API_TIMEOUT', 
        'LANDSBANKINN_API_TIMEOUT',
        'VAT_COMPUTATION_TIMEOUT',
        'DLQ_OVERFLOW',
        'AUDIT_HASH_CORRUPTION'
    ))
);

CREATE INDEX IF NOT EXISTS idx_incidents_order_id ON incidents(order_id);
CREATE INDEX IF NOT EXISTS idx_incidents_failure_type ON incidents(failure_type);
CREATE INDEX IF NOT EXISTS idx_incidents_active ON incidents(resolved_at_utc) WHERE resolved_at_utc IS NULL;
CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at_utc);

-- Unique constraint: one active incident per order + failure type
CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_active_unique 
    ON incidents(order_id, failure_type) 
    WHERE resolved_at_utc IS NULL;