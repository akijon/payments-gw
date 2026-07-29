/**
 * Verifone webhook JWS verification.
 *
 * Verifone signs RFC 8785 canonical JSON using RFC 7797 detached JWS with an
 * unencoded payload. The protected header must therefore explicitly declare
 * `b64: false` and list `b64` in `crit`.
 */

import type { Env } from '../types/env';
import { getJwks, refreshJwks } from './jwks';

interface ProtectedHeader {
  kid?: unknown;
  alg?: unknown;
  b64?: unknown;
  crit?: unknown;
}

function base64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new Error('Invalid base64url input');
  }

  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeProtectedHeader(encodedHeader: string): ProtectedHeader {
  const decoded = new TextDecoder().decode(base64UrlDecode(encodedHeader));
  return JSON.parse(decoded) as ProtectedHeader;
}

function isExpectedDetachedHeader(header: ProtectedHeader): header is {
  kid: string;
  alg: 'RS256';
  b64: false;
  crit: unknown[];
} {
  return (
    typeof header.kid === 'string' &&
    header.kid.length > 0 &&
    header.alg === 'RS256' &&
    header.b64 === false &&
    Array.isArray(header.crit) &&
    header.crit.length === 1 &&
    header.crit[0] === 'b64'
  );
}

function isUsableRsaSigningKey(key: JsonWebKey & { kid?: string }): boolean {
  return (
    key.kty === 'RSA' &&
    typeof key.n === 'string' &&
    typeof key.e === 'string' &&
    (key.use === undefined || key.use === 'sig') &&
    (key.alg === undefined || key.alg === 'RS256')
  );
}

/**
 * Verify an RFC 7797 detached JWS from Verifone.
 *
 * The compact serialization has an empty payload segment (`header..signature`)
 * and signs `BASE64URL(header) + "." + canonicalized JSON` without base64url
 * encoding the payload.
 */
export async function verifyVerifoneWebhook(rawBody: string, jwsHeader: string, env: Env): Promise<boolean> {
  const parts = jwsHeader.split('.');
  if (parts.length !== 3 || parts[1] !== '' || !parts[0] || !parts[2]) {
    return false;
  }

  let protectedHeader: ProtectedHeader;
  let canonicalized: string;
  try {
    protectedHeader = decodeProtectedHeader(parts[0]);
    canonicalized = canonicalizeJson(rawBody);
  } catch {
    return false;
  }

  if (!isExpectedDetachedHeader(protectedHeader)) {
    return false;
  }

  let keys = await getJwks(env);
  let key = keys.find((candidate) => candidate.kid === protectedHeader.kid);
  if (!key) {
    keys = await refreshJwks(env);
    key = keys.find((candidate) => candidate.kid === protectedHeader.kid);
  }

  if (!key || !isUsableRsaSigningKey(key)) {
    return false;
  }

  try {
    const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
      'verify',
    ]);
    const signedData = new TextEncoder().encode(`${parts[0]}.${canonicalized}`);
    const signature = base64UrlDecode(parts[2]);

    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedData);
  } catch {
    return false;
  }
}

/**
 * RFC 8785 JCS canonicalization for JSON values representable in JavaScript.
 * JSON.stringify supplies ECMAScript number/string serialization; recursively
 * sorting object keys produces JCS property ordering (UTF-16 code units).
 */
function canonicalizeJson(input: string): string {
  const parsed = JSON.parse(input);
  return JSON.stringify(canonicalizeValue(parsed));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      sorted[key] = canonicalizeValue(object[key]);
    }
    return sorted;
  }
  throw new Error('Unsupported JSON value');
}
