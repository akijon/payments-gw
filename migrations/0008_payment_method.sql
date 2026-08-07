-- Add payment method tracking to orders table.
-- Required for PayPal/wallet settlement isolation.

-- Existing orders were card-only. New values must remain in the known set;
-- unrecognized provider products are persisted as 'unknown' and never reconciled
-- through the card acquirer.
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'
  CHECK (payment_method IN ('card', 'paypal', 'apple_pay', 'google_pay', 'unknown'));

-- Add index for payment method filtering (used in reconciliation)
CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method);

-- Update existing orders to have explicit card method
-- (This is safe since all existing orders used card payment)
UPDATE orders SET payment_method = 'card' WHERE payment_method IS NULL;

-- Payment method values: 'card', 'paypal', 'apple_pay', 'google_pay'
-- NULL is not allowed - method must be determined from Verifone response