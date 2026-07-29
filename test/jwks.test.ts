import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types/env';
import { refreshJwks } from '../src/lib/jwks';

function testEnv(): Env {
  return {
    CACHE: {
      get: async () => null,
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    VERIFONE_JWKS_URL: 'https://jwks.test.verifone/keys',
  } as Env;
}

afterEach(() => vi.unstubAllGlobals());

describe('Verifone JWKS client', () => {
  it('accepts bounded RSA signing keys and stores a timestamped cache entry', async () => {
    const key = { kid: 'key-1', kty: 'RSA', use: 'sig', n: 'AQAB', e: 'AQAB' };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ keys: [key] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const env = testEnv();

    await expect(refreshJwks(env)).resolves.toEqual([key]);
    const put = vi.mocked(env.CACHE.put);
    expect(put).toHaveBeenCalledOnce();
    const cached = JSON.parse(String(put.mock.calls[0][1])) as { cachedAt: number; keys: unknown[] };
    expect(cached.cachedAt).toBeGreaterThan(0);
    expect(cached.keys).toEqual([key]);
  });

  it('rejects unsupported keys and oversized responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ keys: [{ kid: 'ec-1', kty: 'EC', use: 'sig' }] }), { status: 200 }),
        ),
    );
    await expect(refreshJwks(testEnv())).rejects.toThrow('unsupported key');

    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Length': String(300 * 1024) } })),
    );
    await expect(refreshJwks(testEnv())).rejects.toThrow('too large');
  });

  it('reports only the upstream status on HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive upstream body', { status: 503 })),
    );
    await expect(refreshJwks(testEnv())).rejects.toThrow('Verifone JWKS request failed (503)');
  });
});
