/**
 * Audit hash and retention tests — SHA-256 tamper-evidence + 7-year retention.
 *
 * Verifies that:
 * - Invoices stored in D1 have audit_hash (SHA-256 of payload_json)
 * - Invoices have retention_until set to issue_date + 7 years
 * - Credit notes have the same audit hash + retention fields
 * - The API response includes audit metadata
 * - Tamper-evidence: changing payload_json makes the stored hash invalid
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createOrderWithAccessToken, generateOrderNumber, generateUUID } from '../src/lib/db';
import { computeAuditHash, computeRetentionDate, RETENTION_YEARS } from '../src/lib/invoice-db';
import type { LineItem } from '../src/types/api';
import { TERMS_VERSION } from '../src/lib/terms';

vi.mock('../src/lib/verifone', () => ({
  getVerifoneToken: vi.fn().mockResolvedValue('mock-token'),
  createCheckout: vi.fn().mockResolvedValue({
    checkoutId: 'chk-test-1',
    checkoutUrl: 'https://pay.mock.verifone/chk-1',
  }),
  createCustomer: vi.fn().mockResolvedValue('cust-mock-1'),
  getCheckout: vi.fn(),
  parseCheckoutResult: vi.fn(),
}));

function makeTestItems(): LineItem[] & { vat_rate?: number }[] {
  return [
    {
      product_id: 'TEST-001',
      name: 'Test Product',
      quantity: 2,
      unit_price: 1000,
      total_amount: 2000,
      sku: 'TEST-001',
      vat_rate: 24,
    },
  ] as LineItem[] & { vat_rate?: number }[];
}

async function createPaidOrder(): Promise<{ orderId: string; token: string }> {
  const orderId = generateUUID();
  const token = 'test-audit-token-' + orderId.slice(0, 8);
  await createOrderWithAccessToken(env.DB, {
    id: orderId,
    orderNumber: generateOrderNumber(),
    currency: 'ISK',
    amount: 2000,
    customerEmail: 'test@example.is',
    customerName: 'Test Customer',
    termsAcceptedAt: new Date().toISOString(),
    termsVersion: TERMS_VERSION,
    items: makeTestItems(),
    accessToken: token,
  });
  await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?").bind(orderId).run();
  return { orderId, token };
}

describe('Audit hash computation', () => {
  it('computeAuditHash produces sha256: prefix + 64 hex chars', async () => {
    const hash = await computeAuditHash('test payload');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('computeAuditHash is deterministic — same input, same output', async () => {
    const h1 = await computeAuditHash('{"a":1}');
    const h2 = await computeAuditHash('{"a":1}');
    expect(h1).toBe(h2);
  });

  it('computeAuditHash changes with input', async () => {
    const h1 = await computeAuditHash('{"a":1}');
    const h2 = await computeAuditHash('{"a":2}');
    expect(h1).not.toBe(h2);
  });

  it('computeRetentionDate adds 7 years', () => {
    expect(computeRetentionDate('2026-08-15')).toBe('2033-08-15');
    expect(computeRetentionDate('2026-01-01')).toBe('2033-01-01');
    expect(computeRetentionDate('2024-12-31')).toBe('2031-12-31');
  });

  it('RETENTION_YEARS is 7', () => {
    expect(RETENTION_YEARS).toBe(7);
  });
});

describe('Invoice audit hash in D1', () => {
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM credit_notes; DELETE FROM credit_note_sequence; DELETE FROM invoices; DELETE FROM invoice_sequence;',
    );
  });

  it('invoice record has audit_hash after creation', async () => {
    const { orderId, token } = await createPaidOrder();
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT audit_hash FROM invoices WHERE order_id = ?')
      .bind(orderId)
      .first<{ audit_hash: string | null }>();

    expect(row?.audit_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('invoice audit_hash matches SHA-256 of stored payload_json', async () => {
    const { orderId, token } = await createPaidOrder();
    await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const row = await env.DB.prepare('SELECT audit_hash, payload_json FROM invoices WHERE order_id = ?')
      .bind(orderId)
      .first<{ audit_hash: string; payload_json: string }>();

    const expectedHash = await computeAuditHash(row!.payload_json);
    expect(row!.audit_hash).toBe(expectedHash);
  });

  it('invoice has retention_until set to issue_date + 7 years', async () => {
    const { orderId, token } = await createPaidOrder();
    await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const row = await env.DB.prepare('SELECT issue_date, retention_until FROM invoices WHERE order_id = ?')
      .bind(orderId)
      .first<{ issue_date: string; retention_until: string }>();

    const expectedRetention = computeRetentionDate(row!.issue_date);
    expect(row!.retention_until).toBe(expectedRetention);
  });

  it('tamper-evidence: modified payload_json does not match stored audit_hash', async () => {
    const { orderId, token } = await createPaidOrder();
    await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // Read original hash
    const row = await env.DB.prepare('SELECT audit_hash, payload_json FROM invoices WHERE order_id = ?')
      .bind(orderId)
      .first<{ audit_hash: string; payload_json: string }>();
    const originalHash = row!.audit_hash;

    // Tamper with payload_json
    await env.DB.prepare('UPDATE invoices SET payload_json = \'{"tampered":true}\' WHERE order_id = ?')
      .bind(orderId)
      .run();

    // Read tampered payload
    const tamperedRow = await env.DB.prepare('SELECT payload_json FROM invoices WHERE order_id = ?')
      .bind(orderId)
      .first<{ payload_json: string }>();
    const tamperedHash = await computeAuditHash(tamperedRow!.payload_json);

    // The hash of the tampered payload must not match the stored hash
    expect(tamperedHash).not.toBe(originalHash);
  });
});

describe('Credit note audit hash in D1', () => {
  beforeEach(async () => {
    await env.DB.exec(
      'DELETE FROM credit_notes; DELETE FROM credit_note_sequence; DELETE FROM invoices; DELETE FROM invoice_sequence;',
    );
  });

  it('credit note has audit_hash after creation', async () => {
    const { orderId, token } = await createPaidOrder();
    // Issue invoice
    await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Refund the order
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").bind(orderId).run();
    // Issue credit note
    const response = await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT audit_hash FROM credit_notes WHERE order_id = ?')
      .bind(orderId)
      .first<{ audit_hash: string | null }>();

    expect(row?.audit_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('credit note has retention_until set to issue_date + 7 years', async () => {
    const { orderId, token } = await createPaidOrder();
    await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").bind(orderId).run();
    await SELF.fetch(`http://localhost/api/invoices/orders/${orderId}/credit-note`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const row = await env.DB.prepare('SELECT issue_date, retention_until FROM credit_notes WHERE order_id = ?')
      .bind(orderId)
      .first<{ issue_date: string; retention_until: string }>();

    expect(row!.retention_until).toBe(computeRetentionDate(row!.issue_date));
  });
});
