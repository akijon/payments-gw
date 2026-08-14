/**
 * Verifone API client — unit tests
 *
 * Tests parseCheckoutResult (pure function, no fetch needed).
 * For fetch-dependent functions, see checkout.test.ts which tests via SELF + vi.mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types/env';
import { getVerifoneToken, parseCheckoutResult } from '../src/lib/verifone';
import { __resetForTests } from '../src/lib/circuit-breaker';

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
    VERIFONE_OAUTH_URL: 'https://oauth.test.verifone/access_token',
    VERIFONE_API_BASE: 'https://api.test.verifone/checkout-service',
    VERIFONE_CLIENT_ID: 'client-id',
    VERIFONE_CLIENT_SECRET: 'client-secret',
    VERIFONE_SCOPE: 'checkout',
    VERIFONE_ENTITY_ID: 'entity-1',
  } as Env;
}

describe('parseCheckoutResult', () => {
  it('returns success with transaction ID for TRANSACTION_SUCCESS', () => {
    const detail = {
      id: 'chk-1',
      status: 'COMPLETED',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-s1', timestamp: '2026-07-25T10:00:00Z' }],
    };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('success');
    expect(result.transactionId).toBe('txn-s1');
  });

  it('returns failed for TRANSACTION_FAILED', () => {
    const detail = {
      id: 'chk-2',
      status: 'FAILED',
      events: [{ type: 'TRANSACTION_FAILED', id: 'txn-f1', timestamp: '2026-07-25T10:00:00Z' }],
    };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('failed');
    expect(result.transactionId).toBe('txn-f1');
  });

  it('returns pending when no events', () => {
    const detail = { id: 'chk-3', status: 'PENDING', events: [] };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('pending');
    expect(result.transactionId).toBeUndefined();
  });

  it('returns pending when events undefined', () => {
    const detail = { id: 'chk-4', status: 'PENDING' };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('pending');
  });

  it('prioritizes success over failure', () => {
    const detail = {
      id: 'chk-5',
      status: 'COMPLETED',
      events: [
        { type: 'TRANSACTION_FAILED', id: 'f-early', timestamp: '2026-07-25T09:00:00Z' },
        { type: 'TRANSACTION_SUCCESS', id: 's-late', timestamp: '2026-07-25T10:00:00Z' },
      ],
    };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('success');
    expect(result.transactionId).toBe('s-late');
  });

  it('classifies an SCA/3DS reason code as authentication_required', () => {
    const detail = {
      id: 'chk-6',
      status: 'FAILED',
      events: [
        {
          type: 'TRANSACTION_FAILED',
          id: 'txn-f2',
          timestamp: '2026-07-25T10:00:00Z',
          details: { reason_code: '1815' },
        },
      ],
    };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('authentication_required');
  });

  it('classifies a non-SCA reason code as declined', () => {
    const detail = {
      id: 'chk-7',
      status: 'FAILED',
      events: [
        {
          type: 'TRANSACTION_FAILED',
          id: 'txn-f3',
          timestamp: '2026-07-25T10:00:00Z',
          details: { reason_code: '1000' }, // Do not honour
        },
      ],
    };
    const result = parseCheckoutResult(detail);
    expect(result.failureReason).toBe('declined');
  });

  it('defaults to declined when no reason code is present', () => {
    const detail = {
      id: 'chk-8',
      status: 'FAILED',
      events: [{ type: 'TRANSACTION_FAILED', id: 'txn-f4', timestamp: '2026-07-25T10:00:00Z' }],
    };
    const result = parseCheckoutResult(detail);
    expect(result.failureReason).toBe('declined');
  });
});

describe('createCustomer', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubVerifoneCustomerFetch(): { body: () => Record<string, unknown> } {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('access_token')) {
        return Response.json({ access_token: 'tok', expires_in: 600 });
      }
      return Response.json({ id: 'cust-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    return {
      body: () => {
        const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/v2/customer'));
        if (!call) throw new Error('createCustomer never called /v2/customer');
        return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
      },
    };
  }

  it('sends email_address (not email) and nests name under billing', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    const stub = stubVerifoneCustomerFetch();

    const id = await createCustomer(testEnv(), {
      email: 'shopper@example.com',
      firstName: 'Jón',
      lastName: 'Jónsson',
    });

    expect(id).toBe('cust-1');
    const body = stub.body();
    expect(body.email_address).toBe('shopper@example.com');
    expect(body.email).toBeUndefined();
    expect(body.first_name).toBeUndefined();
    expect(body.billing).toEqual({ first_name: 'Jón', last_name: 'Jónsson' });
  });

  it('includes optional billing address fields when provided', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    const stub = stubVerifoneCustomerFetch();

    await createCustomer(testEnv(), {
      email: 'shopper@example.com',
      firstName: 'Jón',
      lastName: 'Jónsson',
      billingAddress1: 'Laugavegur 1',
      billingCity: 'Reykjavík',
      billingCountryCode: 'IS',
      billingPostalCode: '101',
    });

    expect(stub.body().billing).toEqual({
      first_name: 'Jón',
      last_name: 'Jónsson',
      address_1: 'Laugavegur 1',
      city: 'Reykjavík',
      country_code: 'IS',
      postal_code: '101',
    });
  });

  it('omits billing entirely when no name or address fields are given', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    const stub = stubVerifoneCustomerFetch();

    await createCustomer(testEnv(), { email: 'shopper@example.com' });

    expect(stub.body().billing).toBeUndefined();
  });
});

describe('getVerifoneToken circuit breaker', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not cache a token after a network failure, and opens after repeated failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const env = testEnv();

    for (let i = 0; i < 5; i++) {
      await expect(getVerifoneToken(env)).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // Breaker now open for the 'verifone' key: short-circuits without a 6th fetch.
    await expect(getVerifoneToken(env)).rejects.toThrow('Circuit breaker open');
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // No broken token was ever cached.
    expect(await env.CACHE.get('verifone_oauth_token')).toBeNull();
  });
});
