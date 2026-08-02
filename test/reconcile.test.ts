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

  it('does not send a verified PayPal order through Landsbankinn settlement matching', async () => {
    const { reconcile } = await import('../src/cron/reconcile');
    const order = await seedOrder('paid');
    await env.DB.prepare("UPDATE orders SET payment_method = 'paypal' WHERE id = ?").bind(order.id).run();
    const dependencies = reconciliationDependencies([
      {
        id: 'acquirer-txn-paypal',
        merchantReference: order.orderNumber,
        amount: 18000,
        currency: 'ISK',
        transactionType: 'SALE',
        transactionStatus: 'SETTLED',
      },
    ]);

    await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);

    const stored = await env.DB.prepare('SELECT status, landsbankinn_settlement_id FROM orders WHERE id = ?')
      .bind(order.id)
      .first<{ status: string; landsbankinn_settlement_id: string | null }>();
    expect(stored).toEqual({ status: 'paid', landsbankinn_settlement_id: null });
    const exception = await env.DB.prepare(
      'SELECT reason, details_json FROM reconciliation_exceptions WHERE transaction_id = ?',
    )
      .bind('acquirer-txn-paypal')
      .first<{ reason: string; details_json: string }>();
    expect(exception?.reason).toBe('non_card_payment_method');
    expect(JSON.parse(exception!.details_json)).toMatchObject({ payment_method: 'paypal', order_id: order.id });
  });

  it.each(['apple_pay', 'google_pay'] as const)(
    'reconciles %s through Landsbankinn settlement matching',
    async (paymentMethod) => {
      const { reconcile } = await import('../src/cron/reconcile');
      const order = await seedOrder('paid');
      await env.DB.prepare('UPDATE orders SET payment_method = ? WHERE id = ?').bind(paymentMethod, order.id).run();
      const dependencies = reconciliationDependencies([
        {
          id: `acquirer-txn-${paymentMethod}`,
          merchantReference: order.orderNumber,
          amount: 18000,
          currency: 'ISK',
          transactionType: 'SALE',
          transactionStatus: 'SETTLED',
        },
      ]);

      await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);

      const stored = await env.DB.prepare('SELECT status, landsbankinn_settlement_id FROM orders WHERE id = ?')
        .bind(order.id)
        .first<{ status: string; landsbankinn_settlement_id: string | null }>();
      expect(stored).toEqual({ status: 'settled', landsbankinn_settlement_id: 'settlement-1' });
    },
  );

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

  it('treats a re-delivered settled transaction from an overlapping window as a matched replay', async () => {
    const { reconcile } = await import('../src/cron/reconcile');
    const order = await seedOrder('paid');
    const dependencies = reconciliationDependencies([
      {
        id: 'acquirer-txn-replay',
        merchantReference: order.orderNumber,
        amount: 18000,
        currency: 'ISK',
        transactionType: 'SALE',
        transactionStatus: 'SETTLED',
      },
    ]);

    // First run settles the order under settlement-1 (see reconciliationDependencies).
    await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);
    const afterFirstRun = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.id)
      .first<{ status: string }>();
    expect(afterFirstRun?.status).toBe('settled');

    // Second run's window overlaps the first and re-delivers the same settlement
    // transaction for the now-settled order.
    await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);

    const stored = await env.DB.prepare('SELECT status FROM orders WHERE id = ?')
      .bind(order.id)
      .first<{ status: string }>();
    expect(stored?.status).toBe('settled');

    const exceptionCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM reconciliation_exceptions WHERE order_id = ? AND reason = 'payment_integrity_mismatch'",
    )
      .bind(order.id)
      .first<{ count: number }>();
    expect(exceptionCount?.count).toBe(0);

    const secondRun = await env.DB.prepare(
      'SELECT transactions_matched, transactions_unmatched FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1',
    ).first<{ transactions_matched: number; transactions_unmatched: number }>();
    expect(secondRun).toEqual({ transactions_matched: 1, transactions_unmatched: 0 });
  });

  it('processes a large settlement transaction batch in one pass (pins current no-pagination assumption)', async () => {
    // landsbankinn.ts has no pagination handling today, and this reconciliation loop
    // assumes getSettlementTransactions already returned the complete result set for
    // a settlement. The real Acquiring API's pagination contract (if any) is not
    // documented anywhere in this repo, so this test pins the current assumption
    // (a single injected array is processed in full, uncapped) rather than guessing
    // at unverified vendor pagination semantics. If the real API paginates, this
    // test — and reconcile.ts — must be revisited once that contract is known.
    const { reconcile } = await import('../src/cron/reconcile');
    const TRANSACTION_COUNT = 1200;
    const transactions: SettlementTransaction[] = Array.from({ length: TRANSACTION_COUNT }, (_, i) => ({
      id: `acquirer-txn-bulk-${i}`,
      amount: 100,
      currency: 'ISK',
      transactionType: 'SALE',
      transactionStatus: 'PENDING', // not yet settled -> non_settlable_transaction, no order needed
    }));
    const dependencies = reconciliationDependencies(transactions);

    await (reconcile as unknown as ReconcileWithDependencies)(env, dependencies);

    const run = await env.DB.prepare(
      'SELECT status, transactions_unmatched FROM reconciliation_runs ORDER BY started_at DESC LIMIT 1',
    ).first<{ status: string; transactions_unmatched: number }>();
    expect(run).toEqual({ status: 'completed', transactions_unmatched: TRANSACTION_COUNT });

    const exceptionCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM reconciliation_exceptions WHERE reason = 'non_settlable_transaction'`,
    ).first<{ count: number }>();
    expect(exceptionCount?.count).toBe(TRANSACTION_COUNT);
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
