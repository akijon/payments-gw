/**
 * JWKS manager — fetch and cache Verifone webhook signing keys
 */

import type { Env } from '../types/env';

const JWKS_CACHE_KEY = 'verifone_jwks';
const JWKS_CACHE_TTL = 3600; // 1 hour in seconds

export interface JsonWebKeyWithKid extends JsonWebKey {
  kid?: string;
}

export interface JwksResponse {
  keys: JsonWebKeyWithKid[];
}

let cachedKeys: JsonWebKeyWithKid[] | null = null;

export async function getJwks(env: Env): Promise<JsonWebKeyWithKid[]> {
  // 1. Check in-memory cache
  if (cachedKeys && cachedKeys.length > 0) {
    return cachedKeys;
  }

  // 2. Check KV cache
  const kvCached = await env.CACHE.get<JwksResponse>(JWKS_CACHE_KEY, 'json');
  if (kvCached?.keys?.length) {
    cachedKeys = kvCached.keys;
    return cachedKeys;
  }

  // 3. Fetch from Verifone
  const resp = await fetch(env.VERIFONE_JWKS_URL);
  if (!resp.ok) {
    throw new Error(`Failed to fetch JWKS (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as JwksResponse;
  cachedKeys = data.keys ?? [];

  // 4. Cache in KV
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify(data), {
    expirationTtl: JWKS_CACHE_TTL,
  });

  return cachedKeys;
}

// Force refresh (called when kid not found in cached keys)
export async function refreshJwks(env: Env): Promise<JsonWebKeyWithKid[]> {
  cachedKeys = null; // clear in-memory cache

  const resp = await fetch(env.VERIFONE_JWKS_URL);
  if (!resp.ok) {
    throw new Error(`Failed to refresh JWKS (${resp.status}): ${await resp.text()}`);
  }

  const data = await resp.json() as JwksResponse;
  cachedKeys = data.keys ?? [];

  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify(data), {
    expirationTtl: JWKS_CACHE_TTL,
  });

  return cachedKeys;
}
