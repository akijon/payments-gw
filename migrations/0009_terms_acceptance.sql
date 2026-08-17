-- migrations/0009_terms_acceptance.sql
ALTER TABLE orders ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE orders ADD COLUMN terms_version TEXT;
