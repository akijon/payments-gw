import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/types/env';

interface SettlementTransaction {
  id: string;
  merchantReference?: string;
  amount: number;
  currency: string;
  transactionType: string;
  transactionStatus: string;
}

interface ReconciliationDependencies {
  getSettlements: () => Promise<
    Array<{
      id: string;
      settlementDate: string;
      totalAmount: number;
      currency: string;
      transactionCount: number;
    }>
  >;
  getSettlementTransactions: (settlementId: string) => Promise<SettlementTransaction[]>;
}

type ReconcileWithDependencies = (env: Env, dependencies: ReconciliationDependencies) => Promise<void>;

beforeEach(async () => {
  vi.resetAllMocks();
  await env.DB.exec(
    'DELETE FROM payment_events; DELETE FROM reconciliation_exceptions; DELETE FROM reconciliation_runs; DELETE FROM settlements; DELETE FROM orders;',
  );
});

async function seedOrder(
  status: 'paid' | 'failed' | 'checkout_created',
  amount = 18000,
): Promise<{ id: string; orderNumber: string }> {
  const id = crypto.randomUUID();
  const orderNumber = `IRJA-20260728-${status.toUpperCase()}`;
  await env.DB.prepare(
    `INSERT INTO orders (
      id, order_number, status, currency, amount, items_json, verifone_checkout_id, verifone_transaction_id
    ) VALUES (?, ?, ?, 'ISK', ?, '[]', 'chk-reconcile-1', 'txn-verifone-1')`,
  )
    .bind(id, orderNumber, status, amount)
    .run();
  return { id, orderNumber };
}

function reconciliationDependencies(transactions: SettlementTransaction[]): ReconciliationDependencies {
  return {
    getSettlements: async () => [
      {
        id: 'settlement-1',
        settlementDate: '2026-07-28',
        totalAmount: 18000,
        currency: 'ISK',
        transactionCount: transactions.length,
      },
    ],
    getSettlementTransactions: async () => transactions,
  };
}

describe('reconcile', () => {
  it('settles a paid order only when an approved settlement transaction matches it', async () => {
    const { reconcile } = await import('../src/cron/reconcile');
    const order = await seedOrder('paid');
    const dependencies = reconciliationDependencies([
      {
        id: 'acquirer-txn-1',
        merchantReference: order.orderNumber,
        amount: 18000,
        currency: 'ISK',
        transactionType: 'SALE',
        transactionStatus: 'SETTLED',
      },
    ]);

    await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);

    const stored = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe('settled');
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM payment_events WHERE order_id = ? AND event_type = 'settlement_matched'",
    )
      .bind(order.id)
      .first<{ count: number }>();
    expect(events?.count).toBe(1);
    const run = await env.DB.prepare(
      'SELECT status, transactions_matched FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1',
    ).first<{ status: string; transactions_matched: number }>();
    expect(run).toEqual({ status: 'completed', transactions_matched: 1 });
  });

  it('does not settle a failed order even when the acquirer transaction otherwise matches', async () => {
    const { reconcile } = await import('../src/cron/reconcile');
    const order = await seedOrder('failed');
    const dependencies = reconciliationDependencies([
      {
        id: 'acquirer-txn-failed-order',
        merchantReference: order.orderNumber,
        amount: 18000,
        currency: 'ISK',
        transactionType: 'SALE',
        transactionStatus: 'SETTLED',
      },
    ]);

    await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);

    const stored = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe('failed');
  });

  it('does not settle a paid order when the acquiring amount differs', async () => {
    const { reconcile } = await import('../src/cron/reconcile');
    const order = await seedOrder('paid');
    const dependencies = reconciliationDependencies([
      {
        id: 'acquirer-txn-wrong-amount',
        merchantReference: order.orderNumber,
        amount: 1,
        currency: 'ISK',
        transactionType: 'SALE',
        transactionStatus: 'SETTLED',
      },
    ]);

    await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);

    const stored = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe('paid');
    const exception = await env.DB.prepare('SELECT reason FROM reconciliation_exceptions WHERE order_id = ?')
      .bind(order.id)
      .first<{ reason: string }>();
    expect(exception?.reason).toBe('payment_integrity_mismatch');
  });

  it('persists a failed run without advancing the completed cursor', async () => {
    const { reconcile } = await import('../src/cron/reconcile');
    const dependencies: ReconciliationDependencies = {
      getSettlements: async () => {
        throw new TypeError('network unavailable');
      },
      getSettlementTransactions: async () => [],
    };

    await expect((reconcile as unknown as ReconcileWithDependencies)(env, dependencies)).rejects.toThrow(
      'network unavailable',
    );
    const run = await env.DB.prepare(
      'SELECT status, error_name FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1',
    ).first<{ status: string; error_name: string }>();
    expect(run).toEqual({ status: 'failed', error_name: 'TypeError' });
  });
});
