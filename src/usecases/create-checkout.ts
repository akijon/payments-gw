/**
 * Create-checkout use case — framework-free (no Hono). Given already-validated
 * request fields, resolves catalog pricing, enforces idempotency, creates the
 * order, and creates the Verifone checkout session. The route adapter
 * (src/routes/checkout.ts) owns HTTP-shape concerns only: rate limiting,
 * header/JSON parsing, and rejecting client-controlled money fields.
 */

import type { Env } from '../types/env';
import { CatalogError, resolveCheckoutItems } from '../lib/catalog';

export interface CreateCheckoutInput {
  idempotencyKey: string;
  items: unknown;
  customerEmail?: string;
  customerName?: string;
  buyerKennitala?: string;
  /** Terms-of-sale consent, already validated by the route adapter. */
  termsAccepted: true;
  termsVersion: string;
  publicApiOrigin: string;
  /** Workers execution context — used for ctx.waitUntil on fire-and-forget
   *  background work so the runtime doesn't kill the promise when the
   *  response is sent. */
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
}

interface CreateCheckoutSuccessBody {
  checkout_url: string;
  order_id: string;
  order_number: string;
  amount: number;
  currency: string;
  total_amount: number;
  order_status_token: string;
  idempotent_replay: boolean;
}

interface ErrorBody {
  error: string;
  code: string;
}

export type CreateCheckoutOutcome =
  | { status: 200; body: CreateCheckoutSuccessBody }
  | { status: 400; body: ErrorBody }
  | { status: 409; body: ErrorBody; headers?: Record<string, string> }
  | { status: 502; body: ErrorBody };

export async function createCheckoutUseCase(env: Env, input: CreateCheckoutInput): Promise<CreateCheckoutOutcome> {
  const {
    claimCheckoutAttempt,
    createOrderWithAccessToken,
    deriveOrderAccessToken,
    failCheckoutAttempt,
    failCheckoutCreationAtomically,
    finalizeCheckoutCreationAtomically,
    generateUUID,
    generateOrderNumber,
    getCheckoutAttempt,
    getCheckoutProviderResult,
    getOrderById,
    hashIdempotencyValue,
    reclaimStaleCheckoutAttempt,
    recordCheckoutProviderResult,
    logPaymentEvent,
  } = await import('../lib/db');

  const orderId = generateUUID();
  const orderNumber = generateOrderNumber();
  const keyHash = await hashIdempotencyValue(input.idempotencyKey);
  // Fingerprint the raw client request, not resolved catalog data: a product
  // rename/reprice/deactivation between the original attempt and a replay must
  // not turn a legitimate idempotent replay into a false conflict or catalog
  // error further down.
  const requestHash = await hashIdempotencyValue(
    JSON.stringify({
      items: input.items,
      customer_email: input.customerEmail ?? null,
      customer_name: input.customerName ?? null,
      buyer_kennitala: input.buyerKennitala ?? null,
      terms_accepted: input.termsAccepted,
      terms_version: input.termsVersion,
    }),
  );
  const claim = await claimCheckoutAttempt(env.DB, { keyHash, requestHash, orderId });

  if (!claim.claimed) {
    if (claim.attempt.request_hash !== requestHash) {
      return {
        status: 409,
        body: { error: 'Idempotency-Key was already used for a different checkout', code: 'idempotency_conflict' },
      };
    }
    if (claim.attempt.checkout_url) {
      const existingOrder = await getOrderById(env.DB, claim.attempt.order_id);
      if (!existingOrder) throw new Error('Completed checkout attempt has no order');
      return {
        status: 200,
        body: {
          checkout_url: claim.attempt.checkout_url,
          order_id: existingOrder.id,
          order_number: existingOrder.order_number,
          amount: existingOrder.amount,
          currency: existingOrder.currency,
          total_amount: existingOrder.amount,
          order_status_token: await deriveOrderAccessToken(input.idempotencyKey, existingOrder.id),
          idempotent_replay: true,
        },
      };
    }

    if (claim.attempt.status === 'processing') {
      const providerResult = await getCheckoutProviderResult(env.DB, claim.attempt.order_id);
      if (providerResult) {
        const recovered = await finalizeCheckoutCreationAtomically(env.DB, {
          keyHash,
          orderId: claim.attempt.order_id,
          checkoutId: providerResult.checkoutId,
          checkoutUrl: providerResult.checkoutUrl,
          providerResultEventId: providerResult.eventId,
        });
        const currentAttempt = recovered ? null : await getCheckoutAttempt(env.DB, keyHash);
        const checkoutUrl = recovered ? providerResult.checkoutUrl : currentAttempt?.checkout_url;
        if (!recovered && (currentAttempt?.status !== 'completed' || !checkoutUrl)) {
          throw new Error('Stored provider checkout could not be finalized');
        }

        const existingOrder = await getOrderById(env.DB, claim.attempt.order_id);
        if (!existingOrder) throw new Error('Recovered checkout attempt has no order');
        return {
          status: 200,
          body: {
            checkout_url: checkoutUrl!,
            order_id: existingOrder.id,
            order_number: existingOrder.order_number,
            amount: existingOrder.amount,
            currency: existingOrder.currency,
            total_amount: existingOrder.amount,
            order_status_token: await deriveOrderAccessToken(input.idempotencyKey, existingOrder.id),
            idempotent_replay: true,
          },
        };
      }
    }

    // No checkout_url or recoverable provider result yet: either genuinely in
    // flight, previously failed, or the provider result was never committed
    // locally. The lease prevents a permanent key wedge, but provider
    // idempotency/reconciliation is still required because an accepted provider
    // request can exist without a locally stored result.
    const reclaim = await reclaimStaleCheckoutAttempt(env.DB, { keyHash, requestHash, orderId });
    if (!reclaim.reclaimed) {
      return {
        status: 409,
        body: { error: 'Checkout attempt is not reusable', code: `idempotency_${claim.attempt.status}` },
        headers: { 'Retry-After': claim.attempt.status === 'processing' ? '2' : '0' },
      };
    }
    // Reclaimed: fall through and create a fresh checkout for `orderId`.
  }

  // Only reached for a genuinely new (or reclaimed) attempt — a pure replay hit
  // above already returned without touching the catalog.
  let resolved: Awaited<ReturnType<typeof resolveCheckoutItems>>;
  try {
    resolved = await resolveCheckoutItems(env.DB, input.items);
  } catch (error) {
    await failCheckoutAttempt(env.DB, keyHash);
    if (error instanceof CatalogError) {
      return { status: error.status, body: { error: error.message, code: error.code } };
    }
    throw error;
  }
  const { items, totalAmount, currency } = resolved;

  const orderAccessToken = await deriveOrderAccessToken(input.idempotencyKey, orderId);
  try {
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
  } catch (error) {
    await failCheckoutAttempt(env.DB, keyHash);
    throw error;
  }

  // The provider must return to the gateway, not directly to the storefront.
  const returnUrl = new URL('/api/return', input.publicApiOrigin);
  returnUrl.searchParams.set('order_id', orderId);

  const { createCheckout, createCustomer } = await import('../lib/verifone');

  // Fire customer creation as a background task via ctx.waitUntil so the
  // runtime keeps the promise alive after the response is sent. The customer
  // ID is NOT attached to this checkout — by the time createCheckout runs,
  // the promise hasn't settled yet and the ID would be undefined. Customer
  // creation is purely for future-order enrichment and must never block or
  // fail the payment path. The separate circuit breaker (verifone-customer
  // vs verifone) ensures slow customer API doesn't trip the payment circuit.
  if (input.customerEmail && input.executionCtx) {
    const customerPromise = createCustomer(env, {
      email: input.customerEmail,
      ...(input.customerName ? { firstName: input.customerName.split(' ')[0] } : {}),
      ...(input.customerName ? { lastName: input.customerName.split(' ').slice(1).join(' ') || undefined } : {}),
    }).catch(async (error) => {
      console.error(JSON.stringify({ message: 'Verifone createCustomer failed', order_id: orderId }));
      await logPaymentEvent(env.DB, {
        id: generateUUID(),
        orderId,
        eventType: 'customer_creation_failed',
        source: 'verifone_api',
        rawPayload: JSON.stringify({ error_type: error instanceof Error ? error.name : 'unknown' }),
        verified: false,
      });
    });
    input.executionCtx.waitUntil(customerPromise);
  }

  let checkoutResult: { checkoutId: string; checkoutUrl: string };
  try {
    checkoutResult = await createCheckout(env, {
      orderNumber,
      amount: totalAmount,
      currency,
      returnUrl: returnUrl.toString(),
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'Verifone checkout creation failed', order_id: orderId }));
    const failed = await failCheckoutCreationAtomically(env.DB, {
      keyHash,
      orderId,
      eventId: generateUUID(),
      rawPayload: JSON.stringify({ error_type: error instanceof Error ? error.name : 'unknown' }),
    });
    if (!failed) throw new Error('Checkout order changed before provider failure persistence');
    return {
      status: 502,
      body: { error: 'Failed to create checkout session', code: 'checkout_provider_unavailable' },
    };
  }

  const providerResultEventId = generateUUID();
  const providerResultPayload = JSON.stringify({
    checkoutId: checkoutResult.checkoutId,
    checkoutUrl: checkoutResult.checkoutUrl,
    amount: totalAmount,
    currency,
    item_count: items.length,
  });
  await recordCheckoutProviderResult(env.DB, {
    eventId: providerResultEventId,
    orderId,
    checkoutId: checkoutResult.checkoutId,
    checkoutUrl: checkoutResult.checkoutUrl,
    rawPayload: providerResultPayload,
  });

  const finalized = await finalizeCheckoutCreationAtomically(env.DB, {
    keyHash,
    orderId,
    checkoutId: checkoutResult.checkoutId,
    checkoutUrl: checkoutResult.checkoutUrl,
    providerResultEventId,
  });
  if (!finalized) {
    const [currentAttempt, currentOrder] = await Promise.all([
      getCheckoutAttempt(env.DB, keyHash),
      getOrderById(env.DB, orderId),
    ]);
    const finalizedByRetry =
      currentAttempt?.status === 'completed' &&
      currentAttempt.checkout_url === checkoutResult.checkoutUrl &&
      currentOrder?.status === 'checkout_created' &&
      currentOrder.verifone_checkout_id === checkoutResult.checkoutId;
    if (!finalizedByRetry) throw new Error('Checkout order changed before session persistence');
  }

  return {
    status: 200,
    body: {
      checkout_url: checkoutResult.checkoutUrl,
      order_id: orderId,
      order_number: orderNumber,
      amount: totalAmount,
      currency,
      total_amount: totalAmount,
      order_status_token: orderAccessToken,
      idempotent_replay: false,
    },
  };
}
