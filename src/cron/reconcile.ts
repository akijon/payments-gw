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
import {
  completeReconciliationRun,
  failReconciliationRun,
  generateUUID,
  getLastCompletedReconciliationDateTo,
  getOrderByOrderNumber,
  recordReconciliationException,
  recordSettlementBatch,
  settleOrderAtomically,
  startReconciliationRun,
} from '../lib/db';
import type { LandsbankinnSettlement, LandsbankinnTransaction } from '../types/api';

export interface ReconciliationDependencies {
  getSettlements: (dateFrom: string, dateTo: string) => Promise<LandsbankinnSettlement[]>;
  getSettlementTransactions: (settlementId: string) => Promise<LandsbankinnTransaction[]>;
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
  const previousDateTo = await getLastCompletedReconciliationDateTo(db);
  const fallbackStart = now.getTime() - RECONCILIATION_WINDOW_DAYS * DAY_MS;
  const previousTime = previousDateTo ? Date.parse(`${previousDateTo}T00:00:00Z`) : Number.NaN;
  const startTime = Number.isFinite(previousTime) ? previousTime - DAY_MS : fallbackStart;
  const endTime = Math.min(now.getTime(), startTime + RECONCILIATION_WINDOW_DAYS * DAY_MS);
  return {
    dateFrom: new Date(startTime).toISOString().slice(0, 10),
    dateTo: new Date(endTime).toISOString().slice(0, 10),
  };
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

  await startReconciliationRun(env.DB, { id: runId, startedAt: now.toISOString(), dateFrom, dateTo });
  console.log(
    JSON.stringify({ message: 'Reconciliation started', run_id: runId, date_from: dateFrom, date_to: dateTo }),
  );

  try {
    const settlements = await dependencies.getSettlements(dateFrom, dateTo);
    let totalMatched = 0;
    let totalUnmatched = 0;

    for (const settlement of settlements) {
      const transactions = await dependencies.getSettlementTransactions(settlement.id);
      await recordSettlementBatch(env.DB, settlement);

      for (const transaction of transactions) {
        if (!transaction.merchantReference || !isSettledSale(transaction)) {
          totalUnmatched++;
          await recordReconciliationException(env.DB, {
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

        const order = await getOrderByOrderNumber(env.DB, transaction.merchantReference);

        if (!order) {
          totalUnmatched++;
          await recordReconciliationException(env.DB, {
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

        // Exclude PayPal and unknown payment methods from Landsbankinn reconciliation.
        // Apple Pay and Google Pay are acquirer-backed card payments and reconcile here.
        const paymentMethod = order.payment_method ?? 'unknown';
        if (paymentMethod === 'paypal' || paymentMethod === 'unknown') {
          await recordReconciliationException(env.DB, {
            runId,
            settlementId: settlement.id,
            transactionId: transaction.id,
            reason: 'non_card_payment_method',
            details: {
              payment_method: paymentMethod,
              order_id: order.id,
            },
          });
          console.log('Excluding non-acquirer payment from Landsbankinn reconciliation', {
            orderId: order.id,
            paymentMethod,
            transactionId: transaction.id,
          });
          continue;
        }

        // The reconciliation window deliberately overlaps the prior run, so the same
        // settled transaction can legitimately arrive again. Recognize it as an
        // idempotent replay instead of a payment_integrity_mismatch, which would
        // otherwise corrupt the matched/unmatched counters and page on-call for
        // nothing every single day.
        if (
          order.status === 'settled' &&
          order.landsbankinn_settlement_id === settlement.id &&
          order.amount === transaction.amount &&
          order.currency === transaction.currency
        ) {
          totalMatched++;
          console.log('Skipping already-settled order from an overlapping reconciliation window', {
            orderId: order.id,
            settlementId: settlement.id,
            acquirerTransactionId: transaction.id,
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
          await recordReconciliationException(env.DB, {
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
        const settled = await settleOrderAtomically(env.DB, {
          orderId: order.id,
          settlementId: settlement.id,
          settledAt: now.toISOString(),
          transactionAmount: transaction.amount,
          transactionCurrency: transaction.currency,
          auditPayload: settlementAuditPayload(settlement.id, transaction),
        });

        if (settled) {
          totalMatched++;
        } else {
          totalUnmatched++;
          await recordReconciliationException(env.DB, {
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

    await completeReconciliationRun(env.DB, {
      runId,
      completedAt,
      settlementsProcessed: settlements.length,
      transactionsMatched: totalMatched,
      transactionsUnmatched: totalUnmatched,
    });
    await env.CACHE.put('last_reconciliation', JSON.stringify(summary), {
      expirationTtl: 7 * 86400,
    });
    console.log(JSON.stringify({ message: 'Reconciliation completed', ...summary }));
  } catch (err) {
    const errorName = err instanceof Error ? err.name : 'unknown';
    await failReconciliationRun(env.DB, { runId, completedAt: new Date().toISOString(), errorName });
    console.error(JSON.stringify({ message: 'Reconciliation failed', run_id: runId, error: errorName }));
    throw err;
  }
}
