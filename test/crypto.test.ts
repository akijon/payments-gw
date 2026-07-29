import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types/env';
import { verifyVerifoneWebhook } from '../src/lib/crypto';

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function testEnv(key: JsonWebKey): Env {
  return {
    CACHE: {
      get: async () => ({ keys: [key], cachedAt: Date.now() }),
      put: async () => undefined,
    } as unknown as KVNamespace,
    VERIFONE_JWKS_URL: 'https://jwks.test.verifone/keys',
  } as Env;
}

describe('verifyVerifoneWebhook', () => {
  it('accepts a Verifone-style RFC 7797 detached JWS with an unencoded canonical payload', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & { kid?: string };
    publicJwk.kid = 'test-rfc7797-key';

    const protectedHeader = base64UrlEncode(
      JSON.stringify({
        alg: 'RS256',
        b64: false,
        crit: ['b64'],
        kid: publicJwk.kid,
      }),
    );
    const rawBody = '{"z":"last","a":1}';
    const canonicalPayload = '{"a":1,"z":"last"}';
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        pair.privateKey,
        new TextEncoder().encode(`${protectedHeader}.${canonicalPayload}`),
      ),
    );

    await expect(
      verifyVerifoneWebhook(rawBody, `${protectedHeader}..${base64UrlEncode(signature)}`, testEnv(publicJwk)),
    ).resolves.toBe(true);
  });
});
