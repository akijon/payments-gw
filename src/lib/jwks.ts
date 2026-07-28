/**
 * JWKS manager — fetch and cache Verifone webhook signing keys.
 */

import type { Env } from '../types/env';

const JWKS_CACHE_KEY = 'verifone_jwks';
const JWKS_CACHE_TTL_SECONDS = 3600;
const JWKS_FETCH_TIMEOUT_MS = 5000;
const JWKS_MAX_BYTES = 256 * 1024;
const JWKS_MAX_KEYS = 20;

export interface JsonWebKeyWithKid extends JsonWebKey {
  kid?: string;
}

interface JwksCacheEntry {
  keys: JsonWebKeyWithKid[];
  cachedAt: number;
}

let memoryCache: JwksCacheEntry | null = null;

function validCache(entry: JwksCacheEntry | null | undefined): entry is JwksCacheEntry {
  return Boolean(
    entry &&
    Number.isSafeInteger(entry.cachedAt) &&
    entry.cachedAt > Date.now() - JWKS_CACHE_TTL_SECONDS * 1000 &&
    Array.isArray(entry.keys) &&
    entry.keys.length > 0,
  );
}

function validateKeys(value: unknown): JsonWebKeyWithKid[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { keys?: unknown }).keys)) {
    throw new Error('Verifone JWKS response has an invalid shape');
  }

  const keys = (value as { keys: unknown[] }).keys;
  if (keys.length === 0 || keys.length > JWKS_MAX_KEYS) {
    throw new Error('Verifone JWKS response has an invalid key count');
  }
  for (const key of keys) {
    if (!key || typeof key !== 'object') throw new Error('Verifone JWKS contains an invalid key');
    const candidate = key as Record<string, unknown>;
    if (typeof candidate.kid !== 'string' || candidate.kid.length === 0 || candidate.kid.length > 256) {
      throw new Error('Verifone JWKS contains an invalid key identifier');
    }
    if (
      candidate.kty !== 'RSA' ||
      (candidate.use !== undefined && candidate.use !== 'sig') ||
      (candidate.key_ops !== undefined && (!Array.isArray(candidate.key_ops) || !candidate.key_ops.includes('verify')))
    ) {
      throw new Error('Verifone JWKS contains an unsupported key');
    }
  }
  return keys as JsonWebKeyWithKid[];
}

async function fetchKeys(urlValue: string): Promise<JsonWebKeyWithKid[]> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:') throw new Error('VERIFONE_JWKS_URL must use HTTPS');

  const response = await fetch(url, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Verifone JWKS request failed (${response.status})`);

  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > JWKS_MAX_BYTES) {
    throw new Error('Verifone JWKS response is too large');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > JWKS_MAX_BYTES) throw new Error('Verifone JWKS response is too large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error('Verifone JWKS response is not valid JSON');
  }
  return validateKeys(parsed);
}

async function fetchAndCache(env: Env): Promise<JsonWebKeyWithKid[]> {
  const keys = await fetchKeys(env.VERIFONE_JWKS_URL);
  const entry: JwksCacheEntry = { keys, cachedAt: Date.now() };
  memoryCache = entry;
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify(entry), { expirationTtl: JWKS_CACHE_TTL_SECONDS });
  return keys;
}

export async function getJwks(env: Env): Promise<JsonWebKeyWithKid[]> {
  if (validCache(memoryCache)) return memoryCache.keys;

  const stored = await env.CACHE.get<JwksCacheEntry>(JWKS_CACHE_KEY, 'json');
  if (validCache(stored)) {
    memoryCache = stored;
    return stored.keys;
  }
  return fetchAndCache(env);
}

// Force refresh when the requested kid is absent or key rotation is suspected.
export async function refreshJwks(env: Env): Promise<JsonWebKeyWithKid[]> {
  memoryCache = null;
  return fetchAndCache(env);
}
