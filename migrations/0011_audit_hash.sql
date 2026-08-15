-- migrations/0011_audit_hash.sql
-- Tamper-evidence and 7-year retention for invoices and credit notes.
--
-- Legal basis: Lög um reikningshald nr. 145/1994, reglugerð nr. 505/2013.
-- Invoices must be retained for 7 years and be verifiable as unaltered.
-- The audit_hash is SHA-256 of the exact payload_json as stored at issue time.
-- retention_until is issue_date + 7 years (the date after which the record
-- may be archived or purged, per Icelandic accounting law).

-- ─── Add audit columns to invoices ─────────────────────────────
ALTER TABLE invoices ADD COLUMN audit_hash TEXT;
ALTER TABLE invoices ADD COLUMN retention_until TEXT;

-- Backfill existing invoices: compute hash from payload_json, set retention
UPDATE invoices
  SET audit_hash = 'sha256:' || hex(payload_json),
      retention_until = DATE(issue_date, '+7 years')
  WHERE audit_hash IS NULL AND payload_json IS NOT NULL;

-- ─── Add audit columns to credit_notes ──────────────────────────
ALTER TABLE credit_notes ADD COLUMN audit_hash TEXT;
ALTER TABLE credit_notes ADD COLUMN retention_until TEXT;

UPDATE credit_notes
  SET audit_hash = 'sha256:' || hex(payload_json),
      retention_until = DATE(issue_date, '+7 years')
  WHERE audit_hash IS NULL AND payload_json IS NOT NULL;
