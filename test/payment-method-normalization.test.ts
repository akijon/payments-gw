/**
 * Unit tests for PayPal payment method normalization and extraction.
 *
 * Tests the normalizePaymentMethod function that maps Verifone payment_product
 * values to standardized PaymentMethod enum values.
 */

import { describe, expect, it } from 'vitest';
import { normalizePaymentMethod } from '../src/lib/verifone';

describe('normalizePaymentMethod', () => {
  it('fails closed to unknown for missing products', () => {
    expect(normalizePaymentMethod(undefined)).toBe('unknown');
    expect(normalizePaymentMethod('')).toBe('unknown');
    expect(normalizePaymentMethod('   ')).toBe('unknown');
  });

  it('normalizes PayPal product values', () => {
    expect(normalizePaymentMethod('PAYPAL')).toBe('paypal');
    expect(normalizePaymentMethod('paypal')).toBe('paypal');
    expect(normalizePaymentMethod('  PAYPAL  ')).toBe('paypal');
  });

  it('normalizes Apple Pay product values', () => {
    expect(normalizePaymentMethod('APPLEPAY')).toBe('apple_pay');
    expect(normalizePaymentMethod('APPLE_PAY')).toBe('apple_pay');
    expect(normalizePaymentMethod('applepay')).toBe('apple_pay');
  });

  it('normalizes Google Pay product values', () => {
    expect(normalizePaymentMethod('GOOGLEPAY')).toBe('google_pay');
    expect(normalizePaymentMethod('GOOGLE_PAY')).toBe('google_pay');
    expect(normalizePaymentMethod('googlepay')).toBe('google_pay');
  });

  it('normalizes card product values', () => {
    expect(normalizePaymentMethod('VISA')).toBe('card');
    expect(normalizePaymentMethod('MASTERCARD')).toBe('card');
    expect(normalizePaymentMethod('AMEX')).toBe('card');
    expect(normalizePaymentMethod('AMERICANEXPRESS')).toBe('card');
    expect(normalizePaymentMethod('DISCOVER')).toBe('card');
    expect(normalizePaymentMethod('JCB')).toBe('card');
    expect(normalizePaymentMethod('DINERS')).toBe('card');
    expect(normalizePaymentMethod('MAESTRO')).toBe('card');
    expect(normalizePaymentMethod('visa')).toBe('card');
    expect(normalizePaymentMethod('mastercard')).toBe('card');
  });

  it('normalizes unsupported product values to unknown', () => {
    expect(normalizePaymentMethod('UNKNOWN_WALLET')).toBe('unknown');
    expect(normalizePaymentMethod('BITCOIN')).toBe('unknown');
    expect(normalizePaymentMethod('123456')).toBe('unknown');
    expect(normalizePaymentMethod('INVALID')).toBe('unknown');
  });

  it('handles case insensitivity and whitespace', () => {
    expect(normalizePaymentMethod('  visa  ')).toBe('card');
    expect(normalizePaymentMethod('PayPal')).toBe('paypal');
    expect(normalizePaymentMethod('\tGOOGLEPAY\n')).toBe('google_pay');
  });
});
