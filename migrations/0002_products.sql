-- migrations/0002_products.sql
-- Server-side product catalog — authoritative pricing (never trust client prices)

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,                        -- product_id / SKU (client-facing)
    name TEXT NOT NULL,
    description TEXT,
    unit_price INTEGER NOT NULL,                -- major units (kronur for ISK)
    currency TEXT NOT NULL DEFAULT 'ISK',
    active INTEGER NOT NULL DEFAULT 1,          -- 1 = sellable, 0 = retired
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (unit_price > 0),
    CHECK (active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

-- Seed catalog (sandbox / initial Irja assortment). Prices in ISK.
-- Replace or extend via ops; never accept prices from the client.
INSERT OR IGNORE INTO products (id, name, description, unit_price, currency, active) VALUES
    ('HOODIE-BLK-M',  'Black Hoodie M',           'Black cotton hoodie, size M',           8900,  'ISK', 1),
    ('TSHIRT-WHT-L',  'White T-Shirt L',          'White cotton t-shirt, size L',          4500,  'ISK', 1),
    ('JEANS-BLUE-32', 'Blue Jeans 32',             'Blue denim jeans, waist 32',            12000, 'ISK', 1),
    ('LOPAPEYSA-M',    'Lopapeysa M',               'Traditional Icelandic wool sweater, M', 18000, 'ISK', 1),
    ('LOPAPEYSA-L',    'Lopapeysa L',               'Traditional Icelandic wool sweater, L', 18000, 'ISK', 1),
    ('WOOL-SCARF',    'Wool Scarf',                'Hand-knit Icelandic wool scarf',         7500,  'ISK', 1),
    ('WOOL-HAT',      'Wool Hat',                  'Icelandic wool beanie',                  4500,  'ISK', 1);
