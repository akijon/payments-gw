/**
 * Daily settlement reconciliation.
 *
 * The acquiring API is an external financial boundary: only a successful,
 * amount- and currency-matched transaction may transition a locally verified
 * payment from paid to settled. Every other record is left untouched for
 * manual investigation.
 */

import type { Env } from '../types/env';
import { getSettlements, getSettlementTransactions } from '../lib/landsbankinn';
import { generateUUID } from '../lib/db';
import type { LandsbankinnSettlement, LandsbankinnTransaction } from '../types/api';

export interface ReconciliationDependencies {
  getSettlements: (dateFrom: string, dateTo: string) => Promise<LandsbankinnSettlement[]>;
  getSettlementTransactions: (settlementId: string) => Promise<LandsbankinnTransaction[]>;
}

interface ReconciliationOrder {
  id: string;
  status: string;
  amount: number;
  currency: string;
  verifone_transaction_id: string | null;
}

const APPROVED_TRANSACTION_STATUSES = new Set(['SETTLED']);
const SETTLABLE_TRANSACTION_TYPES = new Set(['SALE']);
const DAY_MS = 24 * 60 * 60 * 1000;
const RECONCILIATION_WINDOW_DAYS = 7;

function isSettledSale(transaction: LandsbankinnTransaction): boolean {
  return (
    APPROVED_TRANSACTION_STATUSES.has(transaction.transactionStatus) &&
    SETTLABLE_TRANSACTION_TYPES.has(transaction.transactionType)
  );
}

function defaultDependencies(env: Env): ReconciliationDependencies {
  return {
    getSettlements: (dateFrom, dateTo) => getSettlements(env, dateFrom, dateTo),
    getSettlementTransactions: (settlementId) => getSettlementTransactions(env, settlementId),
  };
}

function settlementAuditPayload(settlementId: string, transaction: LandsbankinnTransaction): string {
  return JSON.stringify({
    settlement_id: settlementId,
    acquirer_transaction_id: transaction.id,
    merchant_reference: transaction.merchantReference,
    amount: transaction.amount,
    currency: transaction.currency,
    transaction_type: transaction.transactionType,
    transaction_status: transaction.transactionStatus,
  });
}

async function reconciliationWindow(db: D1Database, now: Date): Promise<{ dateFrom: string; dateTo: string }> {
  const previous = await db
    .prepare(
      `SELECT date_to FROM reconciliation_runs
       WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`,
    )
    .first<{ date_to: string }>();
  const fallbackStart = now.getTime() - RECONCILIATION_WINDOW_DAYS * DAY_MS;
  const previousTime = previous ? Date.parse(`${previous.date_to}T00:00:00Z`) : Number.NaN;
  const startTime = Number.isFinite(previousTime) ? previousTime - DAY_MS : fallbackStart;
  const endTime = Math.min(now.getTime(), startTime + RECONCILIATION_WINDOW_DAYS * DAY_MS);
  return {
    dateFrom: new Date(startTime).toISOString().slice(0, 10),
    dateTo: new Date(endTime).toISOString().slice(0, 10),
  };
}

async function recordException(
  db: D1Database,
  input: {
    runId: string;
    settlementId: string;
    transactionId: string;
    orderId?: string;
    reason: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO reconciliation_exceptions
       (id, run_id, settlement_id, transaction_id, order_id, reason, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      generateUUID(),
      input.runId,
      input.settlementId,
      input.transactionId,
      input.orderId ?? null,
      input.reason,
      JSON.stringify(input.details),
    )
    .run();
}

/**
 * Reconcile a UTC date range. Dependencies are injectable only for deterministic
 * tests; production uses the Landsbankinn API client.
 */
export async function reconcile(
  env: Env,
  dependencies: ReconciliationDependencies = defaultDependencies(env),
): Promise<void> {
  const now = new Date();
  const { dateFrom, dateTo } = await reconciliationWindow(env.DB, now);
  const runId = generateUUID();

  await env.DB.prepare(
    `INSERT INTO reconciliation_runs (id, started_at, date_from, date_to, status)
       VALUES (?, ?, ?, ?, 'running')`,
  )
    .bind(runId, now.toISOString(), dateFrom, dateTo)
    .run();
  console.log(
    JSON.stringify({ message: 'Reconciliation started', run_id: runId, date_from: dateFrom, date_to: dateTo }),
  );

  try {
    const settlements = await dependencies.getSettlements(dateFrom, dateTo);
    let totalMatched = 0;
    let totalUnmatched = 0;

    for (const settlement of settlements) {
      const transactions = await dependencies.getSettlementTransactions(settlement.id);

      await env.DB.prepare(
        `INSERT OR IGNORE INTO settlements (
          id, settlement_date, total_amount, currency, transaction_count, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          settlement.id,
          settlement.settlementDate,
          settlement.totalAmount,
          settlement.currency,
          settlement.transactionCount,
          JSON.stringify({
            id: settlement.id,
            settlementDate: settlement.settlementDate,
            totalAmount: settlement.totalAmount,
            currency: settlement.currency,
            transactionCount: settlement.transactionCount,
          }),
        )
        .run();

      for (const transaction of transactions) {
        if (!transaction.merchantReference || !isSettledSale(transaction)) {
          totalUnmatched++;
          await recordException(env.DB, {
            runId,
            settlementId: settlement.id,
            transactionId: transaction.id,
            reason: 'non_settlable_transaction',
            details: {
              merchant_reference: transaction.merchantReference,
              transaction_type: transaction.transactionType,
              transaction_status: transaction.transactionStatus,
            },
          });
          console.warn('Ignoring non-settlable acquiring transaction', {
            transactionId: transaction.id,
            merchantReference: transaction.merchantReference,
            transactionType: transaction.transactionType,
            transactionStatus: transaction.transactionStatus,
          });
          continue;
        }

        const order = await env.DB.prepare(
          `SELECT id, status, amount, currency, verifone_transaction_id
           FROM orders WHERE order_number = ?`,
        )
          .bind(transaction.merchantReference)
          .first<ReconciliationOrder>();

        if (!order) {
          totalUnmatched++;
          await recordException(env.DB, {
            runId,
            settlementId: settlement.id,
            transactionId: transaction.id,
            reason: 'order_not_found',
            details: { merchant_reference: transaction.merchantReference },
          });
          console.warn('No order found for acquiring transaction', {
            transactionId: transaction.id,
            merchantReference: transaction.merchantReference,
          });
          continue;
        }

        if (
          order.status !== 'paid' ||
          !order.verifone_transaction_id ||
          order.amount !== transaction.amount ||
          order.currency !== transaction.currency
        ) {
          totalUnmatched++;
          await recordException(env.DB, {
            runId,
            settlementId: settlement.id,
            transactionId: transaction.id,
            orderId: order.id,
            reason: 'payment_integrity_mismatch',
            details: {
              order_status: order.status,
              has_verified_payment: Boolean(order.verifone_transaction_id),
              order_amount: order.amount,
              transaction_amount: transaction.amount,
              order_currency: order.currency,
              transaction_currency: transaction.currency,
            },
          });
          console.error('Settlement mismatch; order remains unchanged', {
            orderId: order.id,
            orderStatus: order.status,
            hasVerifiedPayment: Boolean(order.verifone_transaction_id),
            orderAmount: order.amount,
            transactionAmount: transaction.amount,
            orderCurrency: order.currency,
            transactionCurrency: transaction.currency,
            acquirerTransactionId: transaction.id,
          });
          continue;
        }

        // Conditional transition prevents duplicate/concurrent callbacks from
        // settling an order or writing an audit record twice.
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE orders
             SET status = 'settled', landsbankinn_settlement_id = ?,
                 settled_at = ?, updated_at = datetime('now')
             WHERE id = ? AND status = 'paid' AND amount = ? AND currency = ?
               AND verifone_transaction_id IS NOT NULL`,
          ).bind(settlement.id, now.toISOString(), order.id, transaction.amount, transaction.currency),
          env.DB.prepare(
            `INSERT INTO payment_events (
              id, order_id, event_type, source, raw_payload, verified
            )
             SELECT ?, ?, 'settlement_matched', 'landsbankinn_api', ?, 1
             WHERE changes() = 1`,
          ).bind(generateUUID(), order.id, settlementAuditPayload(settlement.id, transaction)),
        ]);

        if (results[0].meta.changes === 1) {
          totalMatched++;
        } else {
          totalUnmatched++;
          await recordException(env.DB, {
            runId,
            settlementId: settlement.id,
            transactionId: transaction.id,
            orderId: order.id,
            reason: 'concurrent_state_change',
            details: {},
          });
          console.warn('Settlement transition lost a concurrent state change', {
            orderId: order.id,
            acquirerTransactionId: transaction.id,
          });
        }
      }
    }

    const completedAt = new Date().toISOString();
    const summary = {
      runId,
      runAt: now.toISOString(),
      completedAt,
      dateRange: { from: dateFrom, to: dateTo },
      settlementsProcessed: settlements.length,
      transactionsMatched: totalMatched,
      transactionsUnmatched: totalUnmatched,
    };

    await env.DB.prepare(
      `UPDATE reconciliation_runs
         SET status = 'completed', completed_at = ?, settlements_processed = ?,
             transactions_matched = ?, transactions_unmatched = ?
         WHERE id = ? AND status = 'running'`,
    )
      .bind(completedAt, settlements.length, totalMatched, totalUnmatched, runId)
      .run();
    await env.CACHE.put('last_reconciliation', JSON.stringify(summary), {
      expirationTtl: 7 * 86400,
    });
    console.log(JSON.stringify({ message: 'Reconciliation completed', ...summary }));
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'unknown';
    await env.DB.prepare(
      `UPDATE reconciliation_runs
         SET status = 'failed', completed_at = ?, error_name = ?
         WHERE id = ? AND status = 'running'`,
    )
      .bind(new Date().toISOString(), errorName, runId)
      .run();
    console.error(JSON.stringify({ message: 'Reconciliation failed', run_id: runId, error: errorName }));
    throw err;
  }
}
