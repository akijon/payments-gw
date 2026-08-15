/**
 * Cloudflare Worker environment bindings
 *
 * Secrets are set via `wrangler secret put <NAME>`
 * Non-secret vars are in wrangler.toml [vars]
 */

export interface Env {
  // ─── Cloudflare bindings ───────────────────────────────────
  DB: D1Database;
  CACHE: KVNamespace;
  CHECKOUT_RATE_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };

  // ─── Environment variables (wrangler.toml [vars]) ────────
  ENVIRONMENT: string;
  STOREFRONT_URL: string;
  PUBLIC_API_URL?: string;
  VERIFONE_API_BASE: string;
  VERIFONE_OAUTH_URL: string;
  LANDSBANKINN_API_BASE: string;
  LANDSBANKINN_OAUTH_URL: string;

  // ─── Seller identity (wrangler.toml [vars] or secret) ───
  SELLER_NAME: string;
  SELLER_KENNITALA: string;
  SELLER_VSK_NUMBER: string;
  SELLER_ADDRESS: string;
  SELLER_EMAIL: string;
  SELLER_PHONE?: string;

  // ─── Verifone secrets (wrangler secret put) ──────────────
  VERIFONE_CLIENT_ID: string;
  VERIFONE_CLIENT_SECRET: string;
  VERIFONE_SCOPE: string;
  VERIFONE_ENTITY_ID: string;
  VERIFONE_PAYMENT_CONTRACT_ID: string;
  VERIFONE_3DS_CONTRACT_ID: string;
  VERIFONE_JWKS_URL: string;
  // Optional wallet HPP contracts — unset/blank = method omitted (fail-closed).
  // Do not enable in production until Task 0 method matrix is signed off.
  VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID?: string;
  VERIFONE_APPLE_PAY_PAYMENT_CONTRACT_ID?: string;
  VERIFONE_GOOGLE_PAY_PAYMENT_CONTRACT_ID?: string;

  // ─── Landsbankinn secrets (wrangler secret put) ──────────
  LANDSBANKINN_CLIENT_ID: string;
  LANDSBANKINN_CLIENT_SECRET: string;
  LANDSBANKINN_SCOPE: string;
}
