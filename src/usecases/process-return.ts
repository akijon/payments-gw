/**
 * Process-return use case — framework-free (no Hono). Verifies a Verifone HPP
 * browser return server-to-server and applies the resulting order transition.
 * The route adapter (src/routes/return.ts) owns query-param parsing and the
 * redirect to the storefront.
 */

import type { Env } from '../types/env';
import { PaymentIntegrityError, assertCheckoutIntegrity } from '../lib/payment-integrity';

export interface ProcessReturnInput {
  orderId: string;
  transactionId?: string;
  checkoutId?: string;
}

export type ProcessReturnOutcome = { found: false } | { found: true; status: string };

export async function processReturnUseCase(env: Env, input: ProcessReturnInput): Promise<ProcessReturnOutcome> {
  const { getOrderById, logPaymentEvent, processReturnAtomically, generateUUID } = await import('../lib/db');
  const { getCheckout, parseCheckoutResult } = await import('../lib/verifone');
  const order = await getOrderById(env.DB, input.orderId);

  if (!order) return { found: false };

  if (['paid', 'refunded', 'settled'].includes(order.status)) {
    return { found: true, status: order.status };
  }

  const storedCheckoutId = order.verifone_checkout_id;
  if (!storedCheckoutId) return { found: true, status: 'pending' };

  if (input.checkoutId && input.checkoutId !== storedCheckoutId) {
    await logPaymentEvent(env.DB, {
      id: generateUUID(),
      orderId: order.id,
      eventType: 'checkout_id_mismatch',
      source: 'verifone_return',
      rawPayload: JSON.stringify({ received_checkout_id: input.checkoutId }),
      verified: false,
    });
    return { found: true, status: 'error' };
  }

  try {
    const detail = await getCheckout(env, storedCheckoutId);
    const result = parseCheckoutResult(detail);
    const { normalizePaymentMethod } = await import('../lib/verifone');
    const paymentMethod = normalizePaymentMethod(detail.payment_product);

    try {
      assertCheckoutIntegrity(detail, {
        checkoutId: storedCheckoutId,
        amount: order.amount,
        currency: order.currency,
        merchantReference: order.order_number,
        requireTransactionId: result.status === 'success',
      });
    } catch (error) {
      if (!(error instanceof PaymentIntegrityError)) throw error;
      console.error(
        JSON.stringify({
          message: 'Verifone checkout integrity check failed',
          order_id: order.id,
          code: error.code,
        }),
      );
      await logPaymentEvent(env.DB, {
        id: generateUUID(),
        orderId: order.id,
        eventType: error.code,
        source: 'verifone_return',
        rawPayload: JSON.stringify(error.details),
        verified: true,
      });
      return { found: true, status: 'error' };
    }

    const verifiedTransactionId = detail.transaction_id;
    if (input.transactionId && input.transactionId !== verifiedTransactionId) {
      await logPaymentEvent(env.DB, {
        id: generateUUID(),
        orderId: order.id,
        eventType: 'transaction_id_mismatch',
        source: 'verifone_return',
        rawPayload: JSON.stringify({ received_transaction_id: input.transactionId }),
        verified: true,
      });
      return { found: true, status: 'error' };
    }

    if (result.status === 'success') {
      const applied = await processReturnAtomically(env.DB, {
        orderId: order.id,
        status: 'paid',
        eventType: 'transaction_success',
        transactionId: verifiedTransactionId,
        paymentMethod,
        rawPayload: JSON.stringify({
          checkout_id: detail.id,
          amount: detail.amount,
          currency: detail.currency_code,
        }),
      });
      if (applied) return { found: true, status: 'paid' };
      return { found: true, status: (await getOrderById(env.DB, order.id))?.status ?? 'pending' };
    }

    if (result.status === 'failed') {
      const applied = await processReturnAtomically(env.DB, {
        orderId: order.id,
        status: 'failed',
        eventType: 'transaction_failed',
        transactionId: verifiedTransactionId,
        paymentMethod,
        rawPayload: JSON.stringify({
          checkout_id: detail.id,
          amount: detail.amount,
          currency: detail.currency_code,
        }),
      });
      if (applied) return { found: true, status: 'failed' };
      return { found: true, status: (await getOrderById(env.DB, order.id))?.status ?? 'pending' };
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Verifone return verification temporarily failed',
        order_id: order.id,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }

  return { found: true, status: 'pending' };
}
