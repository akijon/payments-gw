-- migrations/0016_customer_billing.sql
-- Persist the billing identity required to create and attach a Verifone
-- Customer for HPP 3DS checkouts. Columns remain nullable for historical
-- orders created before this contract became mandatory.
ALTER TABLE orders ADD COLUMN billing_first_name TEXT;
ALTER TABLE orders ADD COLUMN billing_last_name TEXT;
ALTER TABLE orders ADD COLUMN billing_address_1 TEXT;
ALTER TABLE orders ADD COLUMN billing_city TEXT;
ALTER TABLE orders ADD COLUMN billing_country_code TEXT;
ALTER TABLE orders ADD COLUMN billing_postal_code TEXT;
ALTER TABLE orders ADD COLUMN billing_state TEXT;
ALTER TABLE orders ADD COLUMN billing_phone TEXT;
ALTER TABLE orders ADD COLUMN verifone_customer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_verifone_customer_id
  ON orders(verifone_customer_id)
  WHERE verifone_customer_id IS NOT NULL;
