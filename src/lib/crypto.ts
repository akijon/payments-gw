/**
 * Cryptographic helpers — JWS verification for Verifone webhooks
 *
 * Verifone uses JWS (JSON Web Signature) with JWKS for webhook verification:
 * 1. Canonicalize JSON body per RFC 8785
 * 2. Parse JWS header to extract kid
 * 3. Find matching key in JWKS by kid
 * 4. Verify signature using Web Crypto API (RS256)
 */

import type { Env } from '../types/env';
import { getJwks, refreshJwks } from './jwks';

/**
 * Verify a Verifone webhook signature
 *
 * @param rawBody - The raw HTTP request body (string)
 * @param jwsHeader - The x-vfi-jws header value (compact JWS serialization)
 * @param env - Worker environment for JWKS refresh
 * @returns true if signature is valid, false otherwise
 */
export async function verifyVerifoneWebhook(
  rawBody: string,
  jwsHeader: string,
  env: Env,
): Promise<boolean> {
  // 1. Parse JWS header to extract kid
  const parts = jwsHeader.split('.');
  if (parts.length !== 3) {
    console.error('Invalid JWS format: expected 3 parts, got', parts.length);
    return false;
  }

  let jwsHeaderObj: { kid?: string; alg?: string };
  try {
    jwsHeaderObj = JSON.parse(atob(parts[0]));
  } catch {
    console.error('Failed to parse JWS header');
    return false;
  }

  const kid = jwsHeaderObj.kid;
  const alg = jwsHeaderObj.alg;

  if (!kid || alg !== 'RS256') {
    console.error('Unsupported JWS: kid or alg missing/wrong', { kid, alg });
    return false;
  }

  // 2. Canonicalize JSON body per RFC 8785
  const canonicalized = canonicalizeJson(rawBody);

  // 3. Find matching key in JWKS
  let keys = await getJwks(env);
  let key = keys.find((k) => k.kid === kid);

  // 4. If key not found, refresh JWKS and retry
  if (!key) {
    console.log('Key not found in JWKS, refreshing...');
    keys = await refreshJwks(env);
    key = keys.find((k) => k.kid === kid);
    if (!key) {
      console.error('Key not found after JWKS refresh:', kid);
      return false;
    }
  }

  // 5. Import the public key and verify signature
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    // For JWS with detached payload, the payload is the canonicalized body
    // Reconstruct the signed data: header + "." + base64url(canonicalized_body)
    const signedData = `${parts[0]}.${base64UrlEncode(canonicalized)}`;

    const signature = base64UrlDecode(parts[2]);

    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signature,
      new TextEncoder().encode(signedData),
    );

    return isValid;
  } catch (err) {
    console.error('JWS verification failed:', err);
    return false;
  }
}

/**
 * Canonicalize JSON per RFC 8785 (JCS — JSON Canonicalization Scheme)
 *
 * This is a simplified implementation. For production, consider using
 * a library like 'canonicalize' or the full RFC 8785 spec.
 */
function canonicalizeJson(input: string): string {
  const parsed = JSON.parse(input);
  return JSON.stringify(canonicalizeValue(parsed));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeValue(obj[key]);
    }
    return result;
  }
  return value;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
