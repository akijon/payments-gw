-- Harden order identity and monetary invariants without rebuilding the existing D1 table.
-- Unique provider identifiers prevent ambiguous order lookup.
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_verifone_checkout_id
ON orders(verifone_checkout_id)
WHERE verifone_checkout_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_verifone_transaction_id
ON orders(verifone_transaction_id)
WHERE verifone_transaction_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS validate_orders_before_insert
BEFORE INSERT ON orders
WHEN NEW.status NOT IN ('pending', 'checkout_created', 'payment_pending', 'paid', 'failed', 'refunded', 'settled')
  OR NEW.amount <= 0
  OR length(NEW.currency) <> 3
  OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]'
BEGIN
  SELECT RAISE(ABORT, 'invalid order state or monetary fields');
END;

CREATE TRIGGER IF NOT EXISTS validate_orders_before_update
BEFORE UPDATE OF status, amount, currency ON orders
WHEN NEW.status NOT IN ('pending', 'checkout_created', 'payment_pending', 'paid', 'failed', 'refunded', 'settled')
  OR NEW.amount <= 0
  OR length(NEW.currency) <> 3
  OR NEW.currency NOT GLOB '[A-Z][A-Z][A-Z]'
BEGIN
  SELECT RAISE(ABORT, 'invalid order state or monetary fields');
END;
