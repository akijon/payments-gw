-- migrations/0009_invoice_tables.sql
-- Icelandic invoice (sölureikningur) support: VAT rates, buyer kennitala,
-- invoice records, sequential numbering per year.
-- Required for legally compliant invoicing per Lög um virðisaukaskatt nr. 50/1988.

-- ─── Add VAT rate to products ────────────────────────────────────
ALTER TABLE products ADD COLUMN vat_rate INTEGER NOT NULL DEFAULT 24
  CHECK (vat_rate IN (0, 11, 24));

-- ─── Add buyer kennitala to orders (optional B2C, required B2B) ─
ALTER TABLE orders ADD COLUMN buyer_kennitala TEXT;

-- ─── Invoice records ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,                        -- UUID v4
    order_id TEXT NOT NULL UNIQUE,              -- one invoice per order
    invoice_number TEXT NOT NULL UNIQUE,        -- REIK-YYYY-NNNNN
    issue_date TEXT NOT NULL,                   -- YYYY-MM-DD
    due_date TEXT,                              -- YYYY-MM-DD (null = immediate)
    delivery_date TEXT,                         -- YYYY-MM-DD (if different from issue)
    buyer_kennitala TEXT,                       -- Icelandic kennitala (XXXXXX-XXXX)
    status TEXT NOT NULL DEFAULT 'issued',      -- issued | void | corrected
    payload_json TEXT,                          -- full computed invoice JSON (immutable after first issue)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    CHECK (status IN ('issued', 'void', 'corrected'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);

-- ─── Sequential invoice numbering per calendar year ─────────────
CREATE TABLE IF NOT EXISTS invoice_sequence (
    year INTEGER PRIMARY KEY,
    next_number INTEGER NOT NULL DEFAULT 1
);
