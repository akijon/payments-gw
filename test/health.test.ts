import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';

interface HealthBody {
  status: string;
  timestamp: string;
  checks?: { d1: 'ok' | 'error'; kv: 'ok' | 'error' };
}

describe('GET /health', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shallow check returns ok without checking D1/KV', async () => {
    const resp = await SELF.fetch('http://localhost/health');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.checks).toBeUndefined();
  });

  it('deep check returns healthy when D1 and KV both respond', async () => {
    const resp = await SELF.fetch('http://localhost/health?deep=1');
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as HealthBody;
    expect(body.status).toBe('healthy');
    expect(body.checks).toEqual({ d1: 'ok', kv: 'ok' });
  });

  it('deep check returns 503 with checks.d1 = error when D1 fails', async () => {
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('d1 down');
    });
    const resp = await SELF.fetch('http://localhost/health?deep=1');
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as HealthBody;
    expect(body.status).toBe('unhealthy');
    expect(body.checks).toEqual({ d1: 'error', kv: 'ok' });
  });

  it('deep check returns 503 with checks.kv = error when KV fails', async () => {
    vi.spyOn(env.CACHE, 'get').mockRejectedValue(new Error('kv down'));
    const resp = await SELF.fetch('http://localhost/health?deep=1');
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as HealthBody;
    expect(body.status).toBe('unhealthy');
    expect(body.checks).toEqual({ d1: 'ok', kv: 'error' });
  });
});
