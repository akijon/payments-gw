-- migrations/0014_shipping_cost.sql
-- Server-side shipping cost on orders and invoices.
--
-- Required by the pricing integrity gate (assertPricingIntegrity):
--   charged_amount == subtotal_excl_vat + total_vat + shipping_incl_vat
--
-- Until now shipping existed only in the storefront (SHIPPING_COST_ISK = 0),
-- so the gateway had no server-side value to reconcile a charge against and
-- could not detect a charge that included shipping the invoice omitted.
--
-- Stored VAT-INCLUSIVE in minor units (aurar), matching the VAT-inclusive
-- catalog pricing used throughout invoice computation.

-- ─── Orders ──────────────────────────────────────────────────────
-- DEFAULT 0 backfills existing rows correctly: every order predating this
-- migration was placed while storefront shipping was 0, so their charged
-- amounts already reconcile without a shipping component.
ALTER TABLE orders ADD COLUMN shipping_incl_vat INTEGER NOT NULL DEFAULT 0
  CHECK (shipping_incl_vat >= 0);

-- ─── Invoices ────────────────────────────────────────────────────
-- Denormalized onto the invoice record so a reissued/recomputed invoice
-- reconciles against the shipping charged at the time of sale, even if the
-- shipping tariff changes later. The immutable payload_json remains the
-- authoritative document; this column exists for querying and audit.
ALTER TABLE invoices ADD COLUMN shipping_incl_vat INTEGER NOT NULL DEFAULT 0
  CHECK (shipping_incl_vat >= 0);

-- Shipping VAT rate is not stored separately: shipping follows the standard
-- 24% rate and is carried inclusive, so the existing vat_breakdown in
-- payload_json remains the single source of VAT decomposition.
