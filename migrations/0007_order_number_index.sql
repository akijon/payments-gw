-- Index order_number for reconciliation cron lookups.
-- reconcile.ts queries WHERE order_number = ? for every settlement transaction;
-- without this index the cron does a full table scan per transaction.
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
