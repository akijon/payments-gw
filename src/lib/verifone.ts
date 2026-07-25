/**
 * Verifone API client — OAuth2 token, checkout creation, checkout verification
 */

import type { Env } from '../types/env';
import type { VerifoneCheckoutResponse, VerifoneCheckoutDetail } from '../types/api';

// ─── OAuth2 token management ─────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

const TOKEN_KEY = 'verifone_oauth_token';
const TOKEN_BUFFER_MS = 30_000; // refresh 30s before expiry

export async function getVerifoneToken(env: Env): Promise<string> {
  // 1. Check KV cache
  const cached = await env.CACHE.get<CachedToken>(TOKEN_KEY, 'json');
  if (cached && cached.expiresAt > Date.now() + TOKEN_BUFFER_MS) {
    return cached.token;
  }

  // 2. Request new token via client credentials grant
  const resp = await fetch(env.VERIFONE_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.VERIFONE_CLIENT_ID,
      client_secret: env.VERIFONE_CLIENT_SECRET,
      scope: env.VERIFONE_SCOPE,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Verifone OAuth2 failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  const token: CachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - TOKEN_BUFFER_MS,
  };

  // 3. Cache in KV with TTL
  await env.CACHE.put(TOKEN_KEY, JSON.stringify(token), {
    expirationTtl: Math.floor((data.expires_in * 1000 - TOKEN_BUFFER_MS) / 1000),
  });

  return token.token;
}

// ─── Create checkout session ────────────────────────────────────

export async function createCheckout(env: Env, params: {
  orderNumber: string;
  amount: number;       // minor units
  currency: string;     // "ISK"
  returnUrl: string;
}): Promise<{ checkoutId: string; checkoutUrl: string }> {
  const token = await getVerifoneToken(env);

  const body = {
    entity_id: env.VERIFONE_ENTITY_ID,
    currency_code: params.currency,
    amount: params.amount,
    merchant_reference: params.orderNumber,
    return_url: params.returnUrl,
    interaction_type: 'HPP' as const,
    configurations: {
      card: {
        mode: '3DS_PAYMENT' as const,
        payment_contract_id: env.VERIFONE_PAYMENT_CONTRACT_ID,
        capture_now: true,
        threed_secure: {
          enabled: true,
          threeds_contract_id: env.VERIFONE_3DS_CONTRACT_ID,
        },
      },
    },
  };

  const resp = await fetch(`${env.VERIFONE_API_BASE}/v2/checkout`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': '*/*',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Verifone createCheckout failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as VerifoneCheckoutResponse;
  return { checkoutId: data.id, checkoutUrl: data.url };
}

// ─── Read checkout (verify payment) ─────────────────────────────

export async function getCheckout(env: Env, checkoutId: string): Promise<VerifoneCheckoutDetail> {
  const token = await getVerifoneToken(env);

  const resp = await fetch(`${env.VERIFONE_API_BASE}/v2/checkout/${checkoutId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': '*/*',
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Verifone getCheckout failed (${resp.status}): ${text}`);
  }

  return await resp.json() as VerifoneCheckoutDetail;
}

// ─── Extract payment status from checkout ────────────────────────

export interface CheckoutPaymentResult {
  status: 'success' | 'failed' | 'pending';
  transactionId?: string;
}

export function parseCheckoutResult(detail: VerifoneCheckoutDetail): CheckoutPaymentResult {
  const events = detail.events ?? [];
  const successEvent = events.find((e) => e.type === 'TRANSACTION_SUCCESS');
  const failedEvent = events.find((e) => e.type === 'TRANSACTION_FAILED');

  if (successEvent) {
    return { status: 'success', transactionId: successEvent.id };
  }
  if (failedEvent) {
    return { status: 'failed', transactionId: failedEvent.id };
  }
  return { status: 'pending' };
}
