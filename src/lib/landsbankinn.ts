/**
 * Landsbankinn Acquiring API client — OAuth2 auth + read-only reconciliation data.
 */

import type { Env } from '../types/env';
import type { LandsbankinnSettlement, LandsbankinnTransaction } from '../types/api';
import { withCircuitBreaker } from './circuit-breaker';
import { getOAuth2ClientCredentialsToken } from './oauth';

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
  return getOAuth2ClientCredentialsToken({
    cache: env.CACHE,
    cacheKey: TOKEN_KEY,
    breakerKey: 'landsbankinn',
    tokenUrl: env.LANDSBANKINN_OAUTH_URL,
    clientId: env.LANDSBANKINN_CLIENT_ID,
    clientSecret: env.LANDSBANKINN_CLIENT_SECRET,
    scope: env.LANDSBANKINN_SCOPE,
    operation: 'Landsbankinn OAuth2',
    bufferMs: TOKEN_BUFFER_MS,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
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
