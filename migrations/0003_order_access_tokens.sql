-- Order status capabilities are stored hashed; the raw token is returned once at checkout.
CREATE TABLE IF NOT EXISTS order_access_tokens (
    order_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id)
);
