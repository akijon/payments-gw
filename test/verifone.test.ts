/**
 * Verifone API client — unit tests
 *
 * Tests parseCheckoutResult (pure function, no fetch needed).
 * For fetch-dependent functions, see checkout.test.ts which tests via SELF + vi.mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types/env';
import { buildVerifoneAuthorization, parseCheckoutResult } from '../src/lib/verifone';
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
    VERIFONE_API_BASE: 'https://api.test.verifone/checkout-service',
    VERIFONE_USER_ID: 'user-id',
    VERIFONE_API_KEY: 'api-key',
    VERIFONE_ENTITY_ID: 'entity-1',
    VERIFONE_PAYMENT_CONTRACT_ID: 'contract-1',
    VERIFONE_3DS_CONTRACT_ID: '3ds-contract-1',
  } as unknown as Env;
}

const CUSTOMER_PARAMS = {
  email: 'shopper@example.com',
  firstName: 'Jón',
  lastName: 'Jónsson',
  billingAddress1: 'Laugavegur 1',
  billingCity: 'Reykjavík',
  billingCountryCode: 'IS',
  billingPostalCode: '101',
} as const;

describe('buildVerifoneAuthorization', () => {
  it('encodes the Verifone user UUID and API key as RFC 7617 Basic credentials', () => {
    const env = {
      VERIFONE_USER_ID: '777c31b3-a85f-4823-93a5-9055d1b',
      VERIFONE_API_KEY: 'api-key-value',
    } as unknown as Env;

    expect(buildVerifoneAuthorization(env)).toBe(`Basic ${btoa('777c31b3-a85f-4823-93a5-9055d1b:api-key-value')}`);
  });

  it.each([
    ['', 'api-key-value'],
    ['user-id', ''],
    ['user:id', 'api-key-value'],
    ['user-id\r\nInjected: value', 'api-key-value'],
    ['user-id', 'api-key-value\r\nInjected: value'],
  ])('rejects malformed credentials before building a header', (userId, apiKey) => {
    const env = { VERIFONE_USER_ID: userId, VERIFONE_API_KEY: apiKey } as unknown as Env;

    expect(() => buildVerifoneAuthorization(env)).toThrow('Invalid Verifone Basic Auth credentials');
  });
});

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

describe('Verifone Basic Auth requests', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the same direct Basic credential for checkout creation and verification', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v2/checkout')) {
        return Response.json({ id: 'chk-1', url: 'https://pay.test.verifone/chk-1' });
      }
      return Response.json({ id: 'chk-1', status: 'PENDING', events: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { createCheckout, getCheckout } = await import('../src/lib/verifone');
    const env = testEnv();

    await createCheckout(env, {
      orderNumber: 'ORD-1',
      amount: 100,
      currency: 'ISK',
      returnUrl: 'https://store.example/api/return',
    });
    await getCheckout(env, 'chk-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa('user-id:api-key')}`);
    }
  });
});

describe('createCustomer', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubVerifoneCustomerFetch(): {
    body: () => Record<string, unknown>;
    authorization: () => string | undefined;
    callCount: () => number;
  } {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init) => {
      void input;
      if (init?.method === 'GET') return Response.json([]);
      return Response.json({ id: 'cust-1' });
    });
    vi.stubGlobal('fetch', fetchMock);

    return {
      body: () => {
        const call = fetchMock.mock.calls.find(
          ([input, init]) => String(input).includes('/v2/customer') && init?.method === 'POST',
        );
        if (!call) throw new Error('createCustomer never called /v2/customer');
        return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
      },
      authorization: () => {
        const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/v2/customer'));
        if (!call) throw new Error('createCustomer never called /v2/customer');
        return new Headers(call[1]?.headers).get('Authorization') ?? undefined;
      },
      callCount: () => fetchMock.mock.calls.length,
    };
  }

  it('rejects missing mandatory 3DS billing fields before any network request', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    const stub = stubVerifoneCustomerFetch();

    await expect(createCustomer(testEnv(), { email: 'shopper@example.com' } as never)).rejects.toThrow(
      'Missing or invalid Verifone customer billing fields',
    );
    expect(stub.callCount()).toBe(0);
  });

  it('reuses an exact existing Verifone customer instead of creating duplicate PII', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe('GET');
      return Response.json([
        {
          id: 'cust-existing',
          entity_id: 'entity-1',
          email_address: CUSTOMER_PARAMS.email,
          billing: {
            first_name: CUSTOMER_PARAMS.firstName,
            last_name: CUSTOMER_PARAMS.lastName,
            address_1: CUSTOMER_PARAMS.billingAddress1,
            city: CUSTOMER_PARAMS.billingCity,
            country_code: CUSTOMER_PARAMS.billingCountryCode,
            postal_code: CUSTOMER_PARAMS.billingPostalCode,
          },
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { createCustomer } = await import('../src/lib/verifone');

    await expect(createCustomer(testEnv(), { ...CUSTOMER_PARAMS })).resolves.toBe('cust-existing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a customer whose optional billing data differs', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'GET') {
        return Response.json([
          {
            id: 'cust-stale',
            entity_id: 'entity-1',
            email_address: CUSTOMER_PARAMS.email,
            billing: {
              first_name: CUSTOMER_PARAMS.firstName,
              last_name: CUSTOMER_PARAMS.lastName,
              address_1: CUSTOMER_PARAMS.billingAddress1,
              city: CUSTOMER_PARAMS.billingCity,
              country_code: CUSTOMER_PARAMS.billingCountryCode,
              postal_code: CUSTOMER_PARAMS.billingPostalCode,
              state: 'OLD',
            },
          },
        ]);
      }
      return Response.json({ id: 'cust-new' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { createCustomer } = await import('../src/lib/verifone');

    await expect(createCustomer(testEnv(), { ...CUSTOMER_PARAMS, billingState: 'NEW' })).resolves.toBe('cust-new');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses Basic Auth directly without an OAuth token request', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    const stub = stubVerifoneCustomerFetch();

    await createCustomer(testEnv(), { ...CUSTOMER_PARAMS });

    expect(stub.callCount()).toBe(2);
    expect(stub.authorization()).toBe(`Basic ${btoa('user-id:api-key')}`);
  });

  it('sends email_address (not email) and nests name under billing', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    const stub = stubVerifoneCustomerFetch();

    const id = await createCustomer(testEnv(), {
      ...CUSTOMER_PARAMS,
    });

    expect(id).toBe('cust-1');
    const body = stub.body();
    expect(body.email_address).toBe('shopper@example.com');
    expect(body.email).toBeUndefined();
    expect(body.first_name).toBeUndefined();
    expect(body.billing).toEqual({
      first_name: 'Jón',
      last_name: 'Jónsson',
      address_1: 'Laugavegur 1',
      city: 'Reykjavík',
      country_code: 'IS',
      postal_code: '101',
    });
  });

  it('includes optional billing address fields when provided', async () => {
    const { createCustomer } = await import('../src/lib/verifone');
    const stub = stubVerifoneCustomerFetch();

    await createCustomer(testEnv(), {
      ...CUSTOMER_PARAMS,
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
});
