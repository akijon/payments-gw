import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';

vi.mock('../../src/lib/verifone', () => ({
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'chk-sec-1',
    checkoutUrl: 'https://pay.mock.verifone/chk-sec-1',
  }),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn().mockResolvedValue({
    id: 'chk-wh',
    status: 'COMPLETED',
    amount: 18000,
    currency_code: 'ISK',
    merchant_reference: 'IRJA-REPLAY',
    events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-1', timestamp: new Date().toISOString() }],
    transaction_id: 'txn-1',
  }),
  parseCheckoutResult: vi.fn().mockReturnValue({ status: 'success', transactionId: 'txn-1' }),
  normalizePaymentMethod: vi.fn().mockReturnValue('card'),
}));

vi.mock('../../src/lib/crypto', () => ({
  verifyVerifoneWebhook: vi.fn().mockResolvedValue(true),
}));

beforeEach(async () => {
  await env.DB.exec(
    'DELETE FROM checkout_attempts; DELETE FROM order_access_tokens; DELETE FROM payment_events; DELETE FROM processed_webhooks; DELETE FROM orders;',
  );
});

describe('Security Regression Detection', () => {
  describe('Price Manipulation Prevention', () => {
    it('MUST reject client-controlled unit_price', async () => {
      const response = await SELF.fetch('http://localhost/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          items: [
            {
              name: 'Expensive Item',
              sku: 'HOODIE-BLK-M',
              quantity: 1,
              unit_price: 1,
            },
          ],
          terms_accepted: true,
          terms_version: '2026-08-17',
        }),
      });

      expect(response.status).toBe(400);
      const responseData = (await response.json()) as { error?: string };
      expect(responseData.error).toMatch(/price|catalog|unauthorized|validation/i);
    });

    it('MUST reject inconsistent price and total_amount', async () => {
      const response = await SELF.fetch('http://localhost/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          items: [
            {
              name: 'Hoodie',
              sku: 'HOODIE-BLK-M',
              quantity: 1,
              unit_price: 8900,
              total_amount: 100,
            },
          ],
          terms_accepted: true,
          terms_version: '2026-08-17',
        }),
      });

      expect(response.status).toBe(400);
      const responseData = (await response.json()) as { error?: string };
      expect(responseData.error).toMatch(/inconsistent|mismatch|calculation/i);
    });

    it('MUST reject unknown product SKUs', async () => {
      const response = await SELF.fetch('http://localhost/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          items: [
            {
              product_id: 'NONEXISTENT-SKU-999',
              quantity: 1,
            },
          ],
          terms_accepted: true,
          terms_version: '2026-08-17',
        }),
      });

      expect(response.status).toBe(400);
      const responseData = (await response.json()) as { error?: string };
      expect(responseData.error).toMatch(/unknown.*sku|product.*not.*found|invalid.*sku|unknown product/i);
    });

    it('MUST require product_id instead of client prices in secure implementation', async () => {
      const secureRequest = {
        items: [
          { product_id: 'HOODIE-BLK-M', quantity: 2 },
          { product_id: 'TSHIRT-WHT-L', quantity: 1 },
        ],
        terms_accepted: true,
        terms_version: '2026-08-17',
      };

      const response = await SELF.fetch('http://localhost/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(secureRequest),
      });

      expect(response.ok).toBe(true);
      const responseData = (await response.json()) as { checkout_url?: string; total_amount?: number; amount?: number };
      expect(responseData.checkout_url).toBeTruthy();
      expect(responseData.total_amount ?? responseData.amount).toBe(22300);
    });
  });

  describe('Webhook Security Integrity', () => {
    it('MUST reject webhooks with invalid JWS signatures', async () => {
      const { verifyVerifoneWebhook } = await import('../../src/lib/crypto');
      vi.mocked(verifyVerifoneWebhook).mockResolvedValueOnce(false);

      const response = await SELF.fetch('http://localhost/api/webhooks/verifone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vfi-jws': 'invalid.signature.here',
        },
        body: JSON.stringify({
          eventType: 'Checkout - Transaction succeeded',
          eventId: 'evt-bad-sig',
          recordId: 'chk-x',
          objectType: 'StandardEvents',
          entityUid: 'e',
          eventDateTime: new Date().toISOString(),
          source: 'Verifone',
        }),
      });

      expect(response.status).toBe(401);
      const responseData = (await response.json()) as { error?: string };
      expect(responseData.error).toMatch(/signature|unauthorized|jws/i);
    });

    it('MUST prevent webhook replay attacks', async () => {
      const checkoutId = 'chk-replay-1';
      const orderId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO orders (id, order_number, status, currency, amount, items_json, verifone_checkout_id)
         VALUES (?, 'IRJA-REPLAY', 'checkout_created', 'ISK', 18000, '[]', ?)`,
      )
        .bind(orderId, checkoutId)
        .run();

      // Align S2S mock amount with order
      const { getCheckout } = await import('../../src/lib/verifone');
      vi.mocked(getCheckout).mockResolvedValue({
        id: checkoutId,
        status: 'COMPLETED',
        amount: 18000,
        currency_code: 'ISK',
        merchant_reference: 'IRJA-REPLAY',
        events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-r', timestamp: new Date().toISOString() }],
        transaction_id: 'txn-r',
      });

      const webhookPayload = {
        eventType: 'Checkout - Transaction succeeded',
        objectType: 'StandardEvents',
        eventId: 'evt-replay-fixed',
        recordId: checkoutId,
        entityUid: 'test-entity',
        eventDateTime: new Date().toISOString(),
        source: 'Verifone',
        content: { id: 'txn-r', amount: 18000, currency_code: 'ISK' },
      };

      const response1 = await SELF.fetch('http://localhost/api/webhooks/verifone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vfi-jws': 'mocked.valid.signature',
        },
        body: JSON.stringify(webhookPayload),
      });

      const response2 = await SELF.fetch('http://localhost/api/webhooks/verifone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-vfi-jws': 'mocked.valid.signature',
        },
        body: JSON.stringify(webhookPayload),
      });

      expect([response1.status, response2.status]).toEqual([200, 200]);
      const data2 = (await response2.json()) as { status: string };
      expect(data2.status).toBe('already_processed');
    });
  });

  describe('Input Validation Security', () => {
    it('MUST sanitize and validate all user inputs', async () => {
      const maliciousInputs = [
        { name: '<script>alert("xss")</script>', sku: '../../../etc/passwd', quantity: 1 },
        { name: 'Normal Item', sku: '../../../etc/passwd', quantity: 1 },
        { product_id: 'HOODIE-BLK-M', quantity: -1 },
        { product_id: 'HOODIE-BLK-M', quantity: 0 },
      ];

      for (const item of maliciousInputs) {
        const response = await SELF.fetch('http://localhost/api/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({ items: [item], terms_accepted: true, terms_version: '2026-08-17' }),
        });

        expect([400, 422]).toContain(response.status);
        const responseData = (await response.json()) as { error?: string };
        expect(responseData.error).toMatch(/validation|invalid|malformed|unknown|quantity|sku|format/i);
      }
    });
  });
});
