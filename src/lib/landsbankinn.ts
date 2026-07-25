/**
 * Landsbankinn Acquiring API client — OAuth2 auth + settlement/transaction retrieval
 *
 * Read-only API for settlement reconciliation.
 * Does NOT create payments — that's Verifone's job.
 */

import type { Env } from '../types/env';
import type { LandsbankinnSettlement, LandsbankinnTransaction } from '../types/api';

// ─── OAuth2 token management ────────────────────────────────────

const TOKEN_KEY = 'landsbankinn_oauth_token';
const TOKEN_BUFFER_MS = 30_000;

export async function getLandsbankinnToken(env: Env): Promise<string> {
  const cached = await env.CACHE.get<{ token: string; expiresAt: number }>(TOKEN_KEY, 'json');
  if (cached && cached.expiresAt > Date.now() + TOKEN_BUFFER_MS) {
    return cached.token;
  }

  const resp = await fetch(env.LANDSBANKINN_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.LANDSBANKINN_CLIENT_ID,
      client_secret: env.LANDSBANKINN_CLIENT_SECRET,
      scope: env.LANDSBANKINN_SCOPE,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Landsbankinn OAuth2 failed (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  const tokenData = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - TOKEN_BUFFER_MS,
  };

  await env.CACHE.put(TOKEN_KEY, JSON.stringify(tokenData), {
    expirationTtl: Math.floor((data.expires_in * 1000 - TOKEN_BUFFER_MS) / 1000),
  });

  return tokenData.token;
}

// ─── Settlement queries ──────────────────────────────────────────

export async function getSettlements(env: Env, dateFrom?: string, dateTo?: string): Promise<LandsbankinnSettlement[]> {
  const token = await getLandsbankinnToken(env);
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  const url = `${env.LANDSBANKINN_API_BASE}/Settlements${params.size ? `?${params}` : ''}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`Landsbankinn getSettlements failed (${resp.status}): ${await resp.text()}`);
  }

  return await resp.json() as LandsbankinnSettlement[];
}

export async function getSettlementTransactions(env: Env, settlementId: string): Promise<LandsbankinnTransaction[]> {
  const token = await getLandsbankinnToken(env);
  const resp = await fetch(`${env.LANDSBANKINN_API_BASE}/Settlements/${settlementId}/Transactions`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`Landsbankinn getSettlementTransactions failed (${resp.status}): ${await resp.text()}`);
  }

  return await resp.json() as LandsbankinnTransaction[];
}

export async function getTransactions(env: Env, dateFrom?: string, dateTo?: string): Promise<LandsbankinnTransaction[]> {
  const token = await getLandsbankinnToken(env);
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);

  const url = `${env.LANDSBANKINN_API_BASE}/Transactions${params.size ? `?${params}` : ''}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });

  if (!resp.ok) {
    throw new Error(`Landsbankinn getTransactions failed (${resp.status}): ${await resp.text()}`);
  }

  return await resp.json() as LandsbankinnTransaction[];
}
