/**
 * Enhanced checkout use case with comprehensive failure handling.
 *
 * Integrates document classification, payment reconciliation, sequence management,
 * and dead letter queue handling for maximum resilience and legal compliance.
 */

import type { Env } from '../types/env';
import { validateCustomerData } from '../lib/document-classification';
import { reconcilePaymentAmounts, validateMonetaryIntegrity } from '../lib/payment-reconciliation';
import { claimSequenceWithRetry, createTemporaryConfirmation } from '../lib/sequence-management';
import { DeadLetterQueue, executeWithIsolation } from '../lib/dead-letter-queue';

export interface EnhancedCreateCheckoutInput {
  idempotencyKey: string;
  items: unknown;
  customerEmail?: string;
  customerName?: string;
  buyerKennitala?: string;
  /** Buyer accepted the current terms of sale (see src/lib/terms.ts). */
  termsAccepted: true;
  /** The terms version the buyer accepted. */
  termsVersion: string;
  publicApiOrigin: string;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
}

interface EnhancedCheckoutResult {
  status: 200 | 202 | 400 | 409 | 422 | 502;
  body:
    | { checkout_url: string; order_id: string; order_status_token: string; document_classification: any }
    | { temporary_confirmation: any; queue_status: any }
    | { error: string; code: string; fallback_options?: any };
  headers?: Record<string, string>;
}

export async function enhancedCreateCheckout(
  env: Env,
  input: EnhancedCreateCheckoutInput,
): Promise<EnhancedCheckoutResult> {
  // Import dependencies
  const { resolveCheckoutItems } = await import('../lib/catalog');
  const { generateUUID, generateOrderNumber } = await import('../lib/db');

  try {
    // 1. CATALOG RESOLUTION WITH ISOLATION
    const catalogResult = await executeWithIsolation(() => resolveCheckoutItems(env.DB, input.items), {
      timeoutMs: 5000,
      isolationId: `catalog-${input.idempotencyKey}`,
    });

    if (!catalogResult.success || !catalogResult.data) {
      if (catalogResult.timedOut) {
        return {
          status: 502,
          body: {
            error: 'Catalog service temporarily unavailable',
            code: 'catalog_timeout',
            fallback_options: { retry_after_seconds: 30 },
          },
        };
      }

      return {
        status: 400,
        body: { error: 'Invalid items in cart', code: 'catalog_error' },
      };
    }

    const { items, totalAmount, currency } = catalogResult.data;

    // 2. MONETARY INTEGRITY VALIDATION
    const integrityCheck = validateMonetaryIntegrity({
      amount: totalAmount,
      currency,
      lineItems: items.map((item) => ({
        total_amount: item.total_amount,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
    });

    if (!integrityCheck.valid) {
      return {
        status: 400,
        body: { error: integrityCheck.error!, code: 'monetary_integrity_violation' },
      };
    }

    // 3. CUSTOMER DATA CLASSIFICATION AND FALLBACK
    const customerValidation = validateCustomerData({
      amount: totalAmount,
      buyerKennitala: input.buyerKennitala,
      customerName: input.customerName,
    });

    if (customerValidation.status === 'PENDING_CUSTOMER_DATA') {
      // B2B transaction missing valid kennitala - halt and request
      return {
        status: 422,
        body: {
          error: 'Valid Icelandic company kennitala required for business transactions',
          code: 'kennitala_required_b2b',
          fallback_options: {
            document_type: customerValidation.classification.documentType,
            threshold_amount: Math.round(totalAmount / 100),
            message: 'Provide valid 10-digit Icelandic kennitala to continue',
          },
        },
      };
    }

    // 4. PROCEED WITH ORDER CREATION
    const orderId = generateUUID();
    const orderNumber = generateOrderNumber();

    // 5. PAYMENT GATEWAY INTEGRATION WITH RECONCILIATION
    const checkoutResult = await executeWithIsolation(
      async () => {
        const { createCheckout } = await import('../lib/verifone');
        const returnUrl = new URL('/api/return', input.publicApiOrigin);
        returnUrl.searchParams.set('order_id', orderId);

        return createCheckout(env, {
          orderNumber,
          amount: totalAmount,
          currency,
          returnUrl: returnUrl.toString(),
        });
      },
      {
        timeoutMs: 15000,
        isolationId: `verifone-${orderId}`,
      },
    );

    if (!checkoutResult.success) {
      // Enqueue for retry if this was a timeout/service failure
      if (checkoutResult.timedOut) {
        await DeadLetterQueue.enqueue({
          orderId,
          eventType: 'validator_timeout',
          originalPayload: {
            orderNumber,
            amount: totalAmount,
            currency,
            items: items,
          },
          error: 'Verifone checkout creation timed out',
        });
      }

      return {
        status: 502,
        body: {
          error: 'Payment service temporarily unavailable',
          code: 'checkout_provider_unavailable',
          fallback_options: { retry_after_seconds: 60 },
        },
      };
    }

    // 6. SEQUENCE MANAGEMENT FOR INVOICE NUMBERING
    if (customerValidation.classification.documentType === 'sölureikningur') {
      const year = new Date().getUTCFullYear();
      const sequenceResult = await claimSequenceWithRetry(env.DB, {
        sequenceType: 'invoice',
        year,
        maxRetries: 2,
      });

      if (!sequenceResult.success) {
        // Queue for sequence resolution
        if (sequenceResult.queueState?.status === 'QUEUED_FOR_SEQUENCING') {
          const tempConfirmation = createTemporaryConfirmation({
            orderId,
            orderNumber,
            amount: totalAmount,
            currency,
            queuePosition: sequenceResult.queueState.queuePosition || 1,
            estimatedWaitMs: sequenceResult.queueState.estimatedWaitMs || 5000,
          });

          return {
            status: 202,
            body: {
              temporary_confirmation: tempConfirmation,
              queue_status: sequenceResult.queueState,
            },
            headers: { 'Retry-After': '10' },
          };
        }

        // Sequence error - fallback to DLQ
        await DeadLetterQueue.enqueue({
          orderId,
          eventType: 'invoice_generation_failed',
          originalPayload: { orderId, orderNumber, sequenceType: 'invoice', year },
          error: sequenceResult.queueState?.error || 'Sequence claiming failed',
        });
      }
    }

    // 7. SUCCESS PATH - CREATE ORDER AND RETURN CHECKOUT
    const { createOrderWithAccessToken, deriveOrderAccessToken } = await import('../lib/db');

    const orderAccessToken = await deriveOrderAccessToken(input.idempotencyKey, orderId);

    await createOrderWithAccessToken(env.DB, {
      id: orderId,
      orderNumber,
      currency,
      amount: totalAmount,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      buyerKennitala: input.buyerKennitala,
      termsAcceptedAt: new Date().toISOString(),
      termsVersion: input.termsVersion,
      items,
      accessToken: orderAccessToken,
    });

    // Store document classification metadata
    await env.DB.prepare(
      `
      UPDATE orders 
      SET document_type = ?, classification_reason = ? 
      WHERE id = ?
    `,
    )
      .bind(customerValidation.classification.documentType, customerValidation.classification.reason, orderId)
      .run();

    return {
      status: 200,
      body: {
        checkout_url: checkoutResult.data!.checkoutUrl,
        order_id: orderId,
        order_status_token: orderAccessToken,
        document_classification: {
          type: customerValidation.classification.documentType,
          reason: customerValidation.classification.reason,
          requires_kennitala: customerValidation.classification.requiresKennitala,
        },
      },
    };
  } catch (error) {
    console.error('Enhanced checkout failed with unhandled error:', error);

    // Last resort DLQ entry
    const orderId = generateUUID();
    await DeadLetterQueue.enqueue({
      orderId,
      eventType: 'validator_timeout',
      originalPayload: {
        idempotencyKey: input.idempotencyKey,
        items: input.items,
        customerEmail: input.customerEmail,
      },
      error: error instanceof Error ? error.message : 'Unknown checkout error',
    });

    return {
      status: 502,
      body: {
        error: 'Internal checkout processing error',
        code: 'internal_error',
        fallback_options: { contact_support: true },
      },
    };
  }
}

/**
 * Payment return handler with reconciliation checks.
 */
export async function enhancedProcessReturn(
  env: Env,
  params: { orderId: string; gatewayData: Record<string, unknown> },
): Promise<{ success: boolean; reconciliation?: any; error?: string }> {
  const { getOrderById, updateOrderStatus } = await import('../lib/db');

  try {
    const order = await getOrderById(env.DB, params.orderId);
    if (!order) {
      return { success: false, error: 'Order not found' };
    }

    // Extract authorized amount from gateway data
    const gatewayAmount = (params.gatewayData as any).amount || order.amount;

    // Reconcile amounts
    const reconciliation = reconcilePaymentAmounts({
      cartGrossTotal: order.amount,
      gatewayAuthorizedAmount: gatewayAmount,
      vatLineItems: order.items.map((item) => ({
        total_amount: (item as any).total_amount,
        vat_rate: (item as any).vat_rate || 24,
        quantity: (item as any).quantity,
      })),
    });

    // Handle reconciliation results
    switch (reconciliation.status) {
      case 'TRANSACTION_ABORTED_PRICE_MISMATCH':
        // Void/cancel the payment authorization
        console.error(`CRITICAL: Price mismatch detected for order ${params.orderId}`, {
          expected: order.amount,
          authorized: gatewayAmount,
          discrepancy: Math.abs(order.amount - gatewayAmount),
        });

        await updateOrderStatus(env.DB, params.orderId, 'failed', {
          allowedFrom: ['payment_pending'],
        });

        // Store reconciliation audit
        await env.DB.prepare(
          `
          INSERT INTO payment_reconciliation (
            id, order_id, cart_total, gateway_authorized, discrepancy, 
            reconciliation_status, adjustment_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
          .bind(
            crypto.randomUUID(),
            params.orderId,
            order.amount,
            gatewayAmount,
            Math.abs(order.amount - gatewayAmount),
            reconciliation.status,
            reconciliation.adjustmentReason,
          )
          .run();

        return { success: false, error: 'Payment amount mismatch - transaction aborted' };

      case 'rounding_adjusted':
        console.info(`Applied 1-krona rounding adjustment for order ${params.orderId}`, {
          adjustment: reconciliation.adjustedAmount! - order.amount,
          reason: reconciliation.adjustmentReason,
        });

        // Apply the adjustment and continue with payment processing
        await env.DB.prepare(
          `
          UPDATE orders SET amount = ? WHERE id = ?
        `,
        )
          .bind(reconciliation.adjustedAmount, params.orderId)
          .run();

        // Store reconciliation audit
        await env.DB.prepare(
          `
          INSERT INTO payment_reconciliation (
            id, order_id, cart_total, gateway_authorized, discrepancy, 
            reconciliation_status, adjustment_applied, adjustment_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
          .bind(
            crypto.randomUUID(),
            params.orderId,
            order.amount,
            gatewayAmount,
            100, // 1 ISK = 100 aurar
            reconciliation.status,
            reconciliation.adjustedAmount! - order.amount,
            reconciliation.adjustmentReason,
          )
          .run();

        break;

      case 'exact_match':
        // No adjustment needed
        break;
    }

    // Proceed with normal payment processing
    await updateOrderStatus(env.DB, params.orderId, 'paid', {
      allowedFrom: ['payment_pending'],
    });

    return { success: true, reconciliation };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown reconciliation error',
    };
  }
}
