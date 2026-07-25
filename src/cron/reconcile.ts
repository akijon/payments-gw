/**
 * Daily reconciliation cron handler
 *
 * Triggered by Workers cron trigger at 06:00 UTC.
 * Fetches Landsbankinn settlements, matches to D1 orders, updates status.
 */

import type { Env } from '../types/env';
import { getSettlements, getSettlementTransactions } from '../lib/landsbankinn';
import { logPaymentEvent, updateOrderStatus, generateUUID } from '../lib/db';

export async function reconcile(env: Env): Promise<void> {
  console.log('Starting daily reconciliation at', new Date().toISOString());

  try {
    // 1. Fetch settlements from the past 24h
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dateFrom = yesterday.toISOString().slice(0, 10);
    const dateTo = now.toISOString().slice(0, 10);

    const settlements = await getSettlements(env, dateFrom, dateTo);
    console.log(`Found ${settlements.length} settlements for ${dateFrom} to ${dateTo}`);

    let totalMatched = 0;
    let totalUnmatched = 0;

    for (const settlement of settlements) {
      console.log(`Processing settlement ${settlement.id} (${settlement.settlementDate})`);

      // 2. Get transactions for this settlement
      const transactions = await getSettlementTransactions(env, settlement.id);

      // 3. Insert settlement record
      await env.DB.prepare(
        `INSERT OR IGNORE INTO settlements (id, settlement_date, total_amount, currency, transaction_count, raw_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        settlement.id,
        settlement.settlementDate,
        settlement.totalAmount,
        settlement.currency,
        settlement.transactionCount,
        JSON.stringify(settlement),
      ).run();

      // 4. Match transactions to orders
      for (const txn of transactions) {
        if (!txn.merchantReference) {
          console.log(`Transaction ${txn.id} has no merchantReference, skipping`);
          totalUnmatched++;
          continue;
        }

        // Look up order by order_number (merchant_reference)
        const order = await env.DB.prepare(
          'SELECT id FROM orders WHERE order_number = ?'
        ).bind(txn.merchantReference).first<{ id: string }>();

        if (!order) {
          console.log(`No order found for merchantReference: ${txn.merchantReference}`);
          totalUnmatched++;
          continue;
        }

        // 5. Update order to settled
        await updateOrderStatus(env.DB, order.id, 'settled', {
          landsbankinnSettlementId: settlement.id,
          settledAt: new Date().toISOString(),
        });

        await logPaymentEvent(env.DB, {
          id: generateUUID(),
          orderId: order.id,
          eventType: 'settlement_matched',
          source: 'landsbankinn_api',
          rawPayload: JSON.stringify(txn),
          verified: true,
        });

        totalMatched++;
      }
    }

    // 6. Write summary to KV for dashboard consumption
    const summary = {
      runAt: now.toISOString(),
      dateRange: { from: dateFrom, to: dateTo },
      settlementsProcessed: settlements.length,
      transactionsMatched: totalMatched,
      transactionsUnmatched: totalUnmatched,
    };

    await env.CACHE.put('last_reconciliation', JSON.stringify(summary), {
      expirationTtl: 86400, // 24h
    });

    console.log('Reconciliation complete:', summary);
  } catch (err) {
    console.error('Reconciliation failed:', err);
    // The cron will retry on the next scheduled run
  }
}
