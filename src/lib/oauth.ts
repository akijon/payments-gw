/**
 * Shared OAuth2 client-credentials token fetch/cache for acquirer API clients.
 *
 * Both Verifone and Landsbankinn issue tokens via RFC 6749 client-credentials
 * grant and expect the same KV cache-then-fetch shape; this centralizes that
 * so a third acquirer integration doesn't copy-paste it again.
 */

import { withCircuitBreaker } from './circuit-breaker';

const RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MIN_EXPIRES_IN_SECONDS = 30;
const MAX_EXPIRES_IN_SECONDS = 604_800; // 7 days

interface CachedOAuthToken {
  token: string;
  expiresAt: number; // epoch ms
}

export interface OAuth2ClientCredentialsParams {
  cache: KVNamespace;
  cacheKey: string;
  breakerKey: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  operation: string;
  bufferMs: number;
  timeoutMs: number;
}

function isFreshCachedToken(cached: unknown, bufferMs: number): cached is CachedOAuthToken {
  const candidate = cached as Partial<CachedOAuthToken> | null;
  return (
    !!candidate &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0 &&
    candidate.token.length <= MAX_TOKEN_LENGTH &&
    Number.isSafeInteger(candidate.expiresAt) &&
    (candidate.expiresAt as number) > Date.now() + bufferMs
  );
}

/** Fetch, size-cap, and JSON-decode an OAuth2 token response. */
async function fetchTokenResponse(params: OAuth2ClientCredentialsParams): Promise<unknown> {
  const response = await withCircuitBreaker(params.breakerKey, () =>
    fetch(params.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: params.clientId,
        client_secret: params.clientSecret,
        scope: params.scope,
      }),
      signal: AbortSignal.timeout(params.timeoutMs),
    }),
  );
  if (!response.ok) throw new Error(`${params.operation} failed (${response.status})`);

  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
    throw new Error(`${params.operation} response is too large`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RESPONSE_MAX_BYTES) throw new Error(`${params.operation} response is too large`);

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error(`${params.operation} returned invalid JSON`);
  }
}

/**
 * Return a cached, non-expired OAuth2 token or fetch and cache a new one via
 * the client-credentials grant. Fails closed: malformed or out-of-range token
 * metadata is rejected and never cached.
 */
export async function getOAuth2ClientCredentialsToken(params: OAuth2ClientCredentialsParams): Promise<string> {
  const cached = await params.cache.get<CachedOAuthToken>(params.cacheKey, 'json');
  if (isFreshCachedToken(cached, params.bufferMs)) {
    return cached.token;
  }

  const data = await fetchTokenResponse(params);
  if (!data || typeof data !== 'object') {
    throw new Error(`${params.operation} returned an invalid response shape`);
  }
  const { access_token: token, expires_in: expiresIn } = data as Record<string, unknown>;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    !Number.isSafeInteger(expiresIn) ||
    (expiresIn as number) <= MIN_EXPIRES_IN_SECONDS ||
    (expiresIn as number) > MAX_EXPIRES_IN_SECONDS
  ) {
    throw new Error(`${params.operation} returned invalid token metadata`);
  }

  const ttlSeconds = (expiresIn as number) - Math.ceil(params.bufferMs / 1000);
  const tokenData: CachedOAuthToken = { token, expiresAt: Date.now() + (expiresIn as number) * 1000 };
  await params.cache.put(params.cacheKey, JSON.stringify(tokenData), { expirationTtl: Math.max(60, ttlSeconds) });
  return token;
}
