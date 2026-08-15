-- migrations/0010_credit_notes.sql
-- Icelandic credit note (kreditreikningur) support.
-- A credit note reverses a previously issued invoice (sölureikningur) when
-- an order is refunded. It references the original invoice number and uses
-- a separate sequential numbering scheme (KREDIT-YYYY-NNNNN).
--
-- Legal basis: Reglugerð nr. 505/2013, Lög um reikningshald nr. 145/1994.
-- A credit note must reference the original invoice it corrects.

CREATE TABLE IF NOT EXISTS credit_notes (
    id TEXT PRIMARY KEY,                            -- UUID v4
    order_id TEXT NOT NULL,                         -- the refunded order
    credit_note_number TEXT NOT NULL UNIQUE,        -- KREDIT-YYYY-NNNNN
    original_invoice_number TEXT NOT NULL,          -- REIK-YYYY-NNNNN being reversed
    issue_date TEXT NOT NULL,                       -- YYYY-MM-DD
    buyer_kennitala TEXT,                           -- Icelandic kennitala (XXXXXX-XXXX)
    status TEXT NOT NULL DEFAULT 'issued',          -- issued | void
    payload_json TEXT,                              -- full computed credit note JSON (immutable)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id),
    CHECK (status IN ('issued', 'void'))
);

CREATE INDEX IF NOT EXISTS idx_credit_notes_order_id ON credit_notes(order_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_number ON credit_notes(credit_note_number);
CREATE INDEX IF NOT EXISTS idx_credit_notes_original ON credit_notes(original_invoice_number);

-- Separate sequence for credit notes (does not share the invoice_sequence)
CREATE TABLE IF NOT EXISTS credit_note_sequence (
    year INTEGER PRIMARY KEY,
    next_number INTEGER NOT NULL DEFAULT 1
);
