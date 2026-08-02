/**
 * Pure unit tests for buildVerifoneCheckoutRequest.
 *
 * Task 1 (verifone-wallets-paypal): env-gated wallet configurations.
 * Capability = non-empty trimmed contract ID. Missing/blank → omit key (fail-closed).
 * No fetch, no D1 — pure data builder only.
 */

import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types/env';
import { buildVerifoneCheckoutRequest } from '../src/lib/verifone';

const BASE_PARAMS = {
  orderNumber: 'ORD-20260802-0001',
  amount: 18_000,
  currency: 'EUR',
  returnUrl: 'https://api.example.test/api/return?order_id=ord-1',
} as const;

/** Minimal Env for the builder — only fields the builder reads. */
function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    VERIFONE_ENTITY_ID: 'entity-1',
    VERIFONE_PAYMENT_CONTRACT_ID: 'card-ppc-1',
    VERIFONE_3DS_CONTRACT_ID: '3ds-contract-1',
    ...overrides,
  } as Env;
}

const CARD_ONLY_CONFIG = {
  card: {
    mode: '3DS_PAYMENT' as const,
    payment_contract_id: 'card-ppc-1',
    capture_now: true,
    threed_secure: {
      enabled: true,
      threeds_contract_id: '3ds-contract-1',
    },
  },
};

describe('buildVerifoneCheckoutRequest', () => {
  it('emits card-only configurations when no wallet contracts are set (baseline)', () => {
    const body = buildVerifoneCheckoutRequest(testEnv(), { ...BASE_PARAMS });

    expect(body).toEqual({
      entity_id: 'entity-1',
      currency_code: 'EUR',
      amount: 18_000,
      merchant_reference: 'ORD-20260802-0001',
      return_url: 'https://api.example.test/api/return?order_id=ord-1',
      interaction_type: 'HPP',
      configurations: CARD_ONLY_CONFIG,
    });
    expect(Object.keys(body.configurations).sort()).toEqual(['card']);
  });

  it('adds paypal when VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID is non-empty (non-ISK)', () => {
    const body = buildVerifoneCheckoutRequest(testEnv({ VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID: 'paypal-ppc-1' }), {
      ...BASE_PARAMS,
    });

    expect(body.configurations.card).toEqual(CARD_ONLY_CONFIG.card);
    expect(body.configurations.paypal).toEqual({ payment_contract_id: 'paypal-ppc-1' });
    expect(Object.keys(body.configurations).sort()).toEqual(['card', 'paypal']);
  });

  it('adds apple_pay when VERIFONE_APPLE_PAY_PAYMENT_CONTRACT_ID is non-empty', () => {
    const body = buildVerifoneCheckoutRequest(testEnv({ VERIFONE_APPLE_PAY_PAYMENT_CONTRACT_ID: 'apple-ppc-1' }), {
      ...BASE_PARAMS,
    });

    expect(body.configurations.apple_pay).toEqual({ payment_contract_id: 'apple-ppc-1' });
    expect(body.configurations.card).toEqual(CARD_ONLY_CONFIG.card);
    expect(Object.keys(body.configurations).sort()).toEqual(['apple_pay', 'card']);
  });

  it('adds google_pay when VERIFONE_GOOGLE_PAY_PAYMENT_CONTRACT_ID is non-empty', () => {
    const body = buildVerifoneCheckoutRequest(testEnv({ VERIFONE_GOOGLE_PAY_PAYMENT_CONTRACT_ID: 'google-ppc-1' }), {
      ...BASE_PARAMS,
    });

    expect(body.configurations.google_pay).toEqual({ payment_contract_id: 'google-ppc-1' });
    expect(body.configurations.card).toEqual(CARD_ONLY_CONFIG.card);
    expect(Object.keys(body.configurations).sort()).toEqual(['card', 'google_pay']);
  });

  it('includes all configured wallets alongside card', () => {
    const body = buildVerifoneCheckoutRequest(
      testEnv({
        VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID: 'paypal-ppc-1',
        VERIFONE_APPLE_PAY_PAYMENT_CONTRACT_ID: 'apple-ppc-1',
        VERIFONE_GOOGLE_PAY_PAYMENT_CONTRACT_ID: 'google-ppc-1',
      }),
      { ...BASE_PARAMS },
    );

    expect(Object.keys(body.configurations).sort()).toEqual(['apple_pay', 'card', 'google_pay', 'paypal']);
    expect(body.configurations.paypal).toEqual({ payment_contract_id: 'paypal-ppc-1' });
    expect(body.configurations.apple_pay).toEqual({ payment_contract_id: 'apple-ppc-1' });
    expect(body.configurations.google_pay).toEqual({ payment_contract_id: 'google-ppc-1' });
  });

  it('omits wallet keys when contract IDs are empty or whitespace-only', () => {
    const body = buildVerifoneCheckoutRequest(
      testEnv({
        VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID: '   ',
        VERIFONE_APPLE_PAY_PAYMENT_CONTRACT_ID: '',
        VERIFONE_GOOGLE_PAY_PAYMENT_CONTRACT_ID: '\t\n',
      }),
      { ...BASE_PARAMS },
    );

    expect(Object.keys(body.configurations).sort()).toEqual(['card']);
    expect(body.configurations).not.toHaveProperty('paypal');
    expect(body.configurations).not.toHaveProperty('apple_pay');
    expect(body.configurations).not.toHaveProperty('google_pay');
    // Serialized JSON must not contain empty wallet objects either.
    expect(JSON.stringify(body.configurations)).toBe(JSON.stringify(CARD_ONLY_CONFIG));
  });

  it('trims wallet contract IDs before emitting them', () => {
    const body = buildVerifoneCheckoutRequest(
      testEnv({ VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID: '  paypal-ppc-trimmed  ' }),
      { ...BASE_PARAMS },
    );

    expect(body.configurations.paypal).toEqual({ payment_contract_id: 'paypal-ppc-trimmed' });
  });

  it('omits paypal for ISK even when a PayPal contract is configured (fail-closed until Task 0)', () => {
    const body = buildVerifoneCheckoutRequest(
      testEnv({
        VERIFONE_PAYPAL_PAYMENT_CONTRACT_ID: 'paypal-ppc-1',
        VERIFONE_APPLE_PAY_PAYMENT_CONTRACT_ID: 'apple-ppc-1',
      }),
      { ...BASE_PARAMS, currency: 'ISK' },
    );

    expect(body.currency_code).toBe('ISK');
    expect(body.configurations).not.toHaveProperty('paypal');
    // Apple Pay remains acquirer-settled; ISK gate is PayPal-only.
    expect(body.configurations.apple_pay).toEqual({ payment_contract_id: 'apple-ppc-1' });
    expect(Object.keys(body.configurations).sort()).toEqual(['apple_pay', 'card']);
  });

  it('rejects invalid amount or currency before any configuration is built', () => {
    expect(() => buildVerifoneCheckoutRequest(testEnv(), { ...BASE_PARAMS, amount: 0 })).toThrow(
      'Invalid checkout amount or currency',
    );
    expect(() => buildVerifoneCheckoutRequest(testEnv(), { ...BASE_PARAMS, amount: 1.5 })).toThrow(
      'Invalid checkout amount or currency',
    );
    expect(() =>
      buildVerifoneCheckoutRequest(testEnv(), { ...BASE_PARAMS, amount: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow('Invalid checkout amount or currency');
    expect(() => buildVerifoneCheckoutRequest(testEnv(), { ...BASE_PARAMS, currency: 'isk' })).toThrow(
      'Invalid checkout amount or currency',
    );
    expect(() => buildVerifoneCheckoutRequest(testEnv(), { ...BASE_PARAMS, currency: 'EURO' })).toThrow(
      'Invalid checkout amount or currency',
    );
  });

  it('accepts only server-owned checkout params (no client method/contract/price fields in input)', () => {
    // Type-level: params are orderNumber/amount/currency/returnUrl only.
    // Runtime: builder ignores anything that is not on Env + those params.
    const body = buildVerifoneCheckoutRequest(testEnv(), { ...BASE_PARAMS });
    expect(body.amount).toBe(BASE_PARAMS.amount);
    expect(body.currency_code).toBe(BASE_PARAMS.currency);
    expect(body.merchant_reference).toBe(BASE_PARAMS.orderNumber);
    expect(body.return_url).toBe(BASE_PARAMS.returnUrl);
    // Contract IDs come from Env, never from params.
    expect(body.configurations.card.payment_contract_id).toBe('card-ppc-1');
  });
});
