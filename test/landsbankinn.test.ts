import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types/env';
import { getLandsbankinnToken, getSettlementTransactions, getSettlements } from '../src/lib/landsbankinn';

function testEnv(): Env {
  const values = new Map<string, string>();
  return {
    CACHE: {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    } as unknown as KVNamespace,
    LANDSBANKINN_OAUTH_URL: 'https://oauth.test.landsbankinn.is/access_token',
    LANDSBANKINN_API_BASE: 'https://api.test.landsbankinn.is/acquiring/v1',
    LANDSBANKINN_CLIENT_ID: 'client-id',
    LANDSBANKINN_CLIENT_SECRET: 'client-secret',
    LANDSBANKINN_SCOPE: 'acquiring',
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Landsbankinn API client', () => {
  it('validates and caches OAuth metadata, then sends an authenticated settlement request', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'sandbox-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'settlement-1' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const env = testEnv();

    expect(await getLandsbankinnToken(env)).toBe('sandbox-token');
    const settlements = await getSettlements(env, '2026-07-01', '2026-07-02');

    expect(settlements).toEqual([{ id: 'settlement-1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('Settlements?dateFrom=2026-07-01&dateTo=2026-07-02');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sandbox-token');
  });

  it('rejects malformed OAuth metadata instead of caching it', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ access_token: '', expires_in: -1 }), { status: 200 })),
    );

    await expect(getLandsbankinnToken(testEnv())).rejects.toThrow('invalid token metadata');
  });

  it('rejects non-array API responses and does not expose provider response bodies', async () => {
    const env = testEnv();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSettlements(env)).rejects.toThrow('invalid response shape');

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive upstream diagnostics', { status: 401 })),
    );
    await expect(getLandsbankinnToken(testEnv())).rejects.toThrow('Landsbankinn OAuth2 failed (401)');
  });

  it('URL-encodes settlement identifiers before fetching transactions', async () => {
    const env = testEnv();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSettlementTransactions(env, 'settlement/../1')).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[1][0])).toContain('Settlements/settlement%2F..%2F1/Transactions');
  });
});
