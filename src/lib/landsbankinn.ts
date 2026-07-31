/**
 * Landsbankinn Acquiring API client — OAuth2 auth + read-only reconciliation data.
 */

import type { Env } from '../types/env';
import type { LandsbankinnSettlement, LandsbankinnTransaction } from '../types/api';
import { withCircuitBreaker } from './circuit-breaker';

const TOKEN_KEY = 'landsbankinn_oauth_token';
const TOKEN_BUFFER_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 1024 * 1024;

function apiUrl(base: string, path: string): URL {
  const exactBase = new URL(base);
  if (exactBase.protocol !== 'https:') throw new Error('Landsbankinn API URLs must use HTTPS');
  if (path === '') return exactBase;
  const directoryBase = new URL(base.endsWith('/') ? base : `${base}/`);
  return new URL(path.replace(/^\//, ''), directoryBase);
}

async function fetchJson(url: URL, init: RequestInit, operation: string): Promise<unknown> {
  const response = await withCircuitBreaker('landsbankinn', () =>
    fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  );
  if (!response.ok) throw new Error(`${operation} failed (${response.status})`);

  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
    throw new Error(`${operation} response is too large`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RESPONSE_MAX_BYTES) throw new Error(`${operation} response is too large`);

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function expectArray<T>(value: unknown, operation: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${operation} returned an invalid response shape`);
  return value as T[];
}

export async function getLandsbankinnToken(env: Env): Promise<string> {
  const cached = await env.CACHE.get<{ token: string; expiresAt: number }>(TOKEN_KEY, 'json');
  if (
    cached &&
    typeof cached.token === 'string' &&
    cached.token.length > 0 &&
    cached.token.length <= 8192 &&
    Number.isSafeInteger(cached.expiresAt) &&
    cached.expiresAt > Date.now() + TOKEN_BUFFER_MS
  ) {
    return cached.token;
  }

  const data = await fetchJson(
    apiUrl(env.LANDSBANKINN_OAUTH_URL, ''),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.LANDSBANKINN_CLIENT_ID,
        client_secret: env.LANDSBANKINN_CLIENT_SECRET,
        scope: env.LANDSBANKINN_SCOPE,
      }),
    },
    'Landsbankinn OAuth2',
  );
  if (!data || typeof data !== 'object') throw new Error('Landsbankinn OAuth2 returned an invalid response shape');
  const { access_token: token, expires_in: expiresIn } = data as Record<string, unknown>;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 8192 ||
    !Number.isSafeInteger(expiresIn) ||
    (expiresIn as number) <= 30 ||
    (expiresIn as number) > 604_800
  ) {
    throw new Error('Landsbankinn OAuth2 returned invalid token metadata');
  }

  const ttlSeconds = (expiresIn as number) - Math.ceil(TOKEN_BUFFER_MS / 1000);
  const tokenData = { token, expiresAt: Date.now() + (expiresIn as number) * 1000 };
  await env.CACHE.put(TOKEN_KEY, JSON.stringify(tokenData), { expirationTtl: ttlSeconds });
  return token;
}

async function authenticatedGet(env: Env, path: string, operation: string): Promise<unknown> {
  const token = await getLandsbankinnToken(env);
  return fetchJson(
    apiUrl(env.LANDSBANKINN_API_BASE, path),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    operation,
  );
}

export async function getSettlements(env: Env, dateFrom?: string, dateTo?: string): Promise<LandsbankinnSettlement[]> {
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  const suffix = params.size ? `?${params}` : '';
  return expectArray<LandsbankinnSettlement>(
    await authenticatedGet(env, `Settlements${suffix}`, 'Landsbankinn getSettlements'),
    'Landsbankinn getSettlements',
  );
}

export async function getSettlementTransactions(env: Env, settlementId: string): Promise<LandsbankinnTransaction[]> {
  if (!settlementId || settlementId.length > 256) throw new Error('Invalid settlement identifier');
  return expectArray<LandsbankinnTransaction>(
    await authenticatedGet(
      env,
      `Settlements/${encodeURIComponent(settlementId)}/Transactions`,
      'Landsbankinn getSettlementTransactions',
    ),
    'Landsbankinn getSettlementTransactions',
  );
}

export async function getTransactions(
  env: Env,
  dateFrom?: string,
  dateTo?: string,
): Promise<LandsbankinnTransaction[]> {
  const params = new URLSearchParams();
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  const suffix = params.size ? `?${params}` : '';
  return expectArray<LandsbankinnTransaction>(
    await authenticatedGet(env, `Transactions${suffix}`, 'Landsbankinn getTransactions'),
    'Landsbankinn getTransactions',
  );
}
