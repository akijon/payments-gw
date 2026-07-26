import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/types/env';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

// Mock Verifone API to focus on the price manipulation vulnerability
vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'test-checkout-id',
    checkoutUrl: 'https://test.verifone.com/checkout/test-checkout-id',
  }),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

beforeEach(async () => {
  await env.DB.exec('DELETE FROM orders;');
  await env.DB.exec('DELETE FROM payment_events;');
  await env.DB.exec('DELETE FROM processed_webhooks;');
});

describe('Price Manipulation Security Tests', () => {

  it('should reject checkout when client manipulates unit price to $0.01', async () => {
    // Attack: Client sets unit_price to 1 aurar (0.01 ISK) for expensive item
    const maliciousRequest = {
      items: [
        {
          name: 'Expensive Product (RRP: 50000 aurar)',
          quantity: 1,
          unit_price: 1,        // ❌ ATTACK: Should be 50000, client sets to 1
          total_amount: 1,      // ❌ ATTACK: Should be 50000, client sets to 1
          sku: 'EXPENSIVE-001'
        }
      ],
      customer_email: 'attacker@example.com'
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maliciousRequest),
    });

    // Current vulnerable implementation will accept this - TEST SHOULD FAIL
    // Secure implementation should reject client-supplied prices
    expect(response.status).toBe(400);
    
    const responseData = await response.json() as { error?: string };
    expect(responseData.error).toContain('price manipulation');
  });

  it('should reject checkout when client provides inconsistent price and total', async () => {
    // Attack: Client sends mismatched unit_price * quantity vs total_amount
    const maliciousRequest = {
      items: [
        {
          name: 'Test Product',
          quantity: 10,
          unit_price: 1000,     // 1000 * 10 = 10000
          total_amount: 100,    // ❌ ATTACK: Claims total is only 100
          sku: 'TEST-001'
        }
      ],
      customer_email: '[EMAIL]'
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maliciousRequest),
    });

    // Current vulnerable implementation accepts inconsistent totals - TEST SHOULD FAIL
    expect(response.status).toBe(400);
    
    const responseData = await response.json() as { error?: string };
    expect(responseData.error).toContain('inconsistent pricing');
  });

  it('should reject checkout when client provides unknown SKU', async () => {
    // Attack: Client fabricates SKU for non-existent product
    const maliciousRequest = {
      items: [
        {
          name: 'Fabricated Product',
          quantity: 1,
          unit_price: 1,        // ❌ ATTACK: Made-up price
          total_amount: 1,      // ❌ ATTACK: Made-up total
          sku: 'FAKE-999999'    // ❌ ATTACK: Non-existent SKU
        }
      ],
      customer_email: 'attacker@example.com'
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maliciousRequest),
    });

    // Current vulnerable implementation accepts unknown SKUs - TEST SHOULD FAIL
    expect(response.status).toBe(400);
    
    const responseData = await response.json() as { error?: string };
    expect(responseData.error).toContain('unknown product');
  });

  it('should demonstrate current vulnerable behavior (this test documents the vulnerability)', async () => {
    // This test documents the current vulnerable behavior
    // It should pass now but fail once we implement secure pricing
    const vulnerableRequest = {
      items: [
        {
          name: 'High-Value Item',
          quantity: 1,
          unit_price: 1,        // Attacker sets price to 1 aurar
          total_amount: 1,      // Attacker sets total to 1 aurar
          sku: 'WHATEVER-123'   // Attacker uses any SKU
        }
      ],
      customer_email: 'attacker@example.com'
    };

    const response = await SELF.fetch('http://example.com/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vulnerableRequest),
    });

    // VULNERABILITY: Current implementation accepts this malicious request
    expect(response.status).toBe(200);
    
    const responseData = await response.json() as { checkout_url?: string; order_id?: string };
    expect(responseData.checkout_url).toBeDefined();
    expect(responseData.order_id).toBeDefined();
    
    // The attacker successfully created a 1 aurar ($0.0001) checkout for any item
    console.warn('🚨 SECURITY VULNERABILITY CONFIRMED: Client can set arbitrary prices');
  });
});