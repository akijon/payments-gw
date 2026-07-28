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

  // ─── Verifone secrets (wrangler secret put) ──────────────
  VERIFONE_CLIENT_ID: string;
  VERIFONE_CLIENT_SECRET: string;
  VERIFONE_SCOPE: string;
  VERIFONE_ENTITY_ID: string;
  VERIFONE_PAYMENT_CONTRACT_ID: string;
  VERIFONE_3DS_CONTRACT_ID: string;
  VERIFONE_JWKS_URL: string;

  // ─── Landsbankinn secrets (wrangler secret put) ──────────
  LANDSBANKINN_CLIENT_ID: string;
  LANDSBANKINN_CLIENT_SECRET: string;
  LANDSBANKINN_SCOPE: string;
}
