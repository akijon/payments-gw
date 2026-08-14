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
  publicApiOrigin: string;
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
    completeCheckoutAttempt,
    createOrderWithAccessToken,
    deriveOrderAccessToken,
    failCheckoutAttempt,
    generateUUID,
    generateOrderNumber,
    getOrderById,
    hashIdempotencyValue,
    reclaimStaleCheckoutAttempt,
    recordCheckoutUrl,
    updateOrderStatus,
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

    // No checkout_url yet: either genuinely in flight, previously failed, or the
    // Worker died before a provider session could have been created (checkout_url
    // is written immediately once one exists — see recordCheckoutUrl). In the last
    // case it is safe to reclaim the row and retry as a fresh claim.
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
      items,
      accessToken: orderAccessToken,
    });
  } catch (error) {
    await failCheckoutAttempt(env.DB, keyHash);
    throw error;
  }

  // Create a Verifone customer record when we have an email to attach to it.
  // Runs after order creation so a failure here always has a real order row to
  // log the audit event against (payment_events.order_id is a foreign key). A
  // customer record only improves 3DS authentication quality (Verifone's docs
  // mark full billing address as required for that benefit, which the
  // storefront doesn't collect yet — see CreateCustomerParams billing fields)
  // and is never worth failing a card payment over, so failures are logged and
  // swallowed rather than blocking checkout.
  let verifoneCustomerId: string | undefined;
  if (input.customerEmail) {
    const { createCustomer } = await import('../lib/verifone');
    try {
      verifoneCustomerId = await createCustomer(env, {
        email: input.customerEmail,
        ...(input.customerName ? { firstName: input.customerName.split(' ')[0] } : {}),
        ...(input.customerName ? { lastName: input.customerName.split(' ').slice(1).join(' ') || undefined } : {}),
      });
    } catch (error) {
      console.error(JSON.stringify({ message: 'Verifone createCustomer failed', order_id: orderId }));
      await logPaymentEvent(env.DB, {
        id: generateUUID(),
        orderId,
        eventType: 'customer_creation_failed',
        source: 'verifone_api',
        rawPayload: JSON.stringify({ error_type: error instanceof Error ? error.name : 'unknown' }),
        verified: false,
      });
      // Best effort only — proceed without a customer id.
    }
  }

  const { createCheckout } = await import('../lib/verifone');
  // The provider must return to the gateway, not directly to the storefront.
  const returnUrl = new URL('/api/return', input.publicApiOrigin);
  returnUrl.searchParams.set('order_id', orderId);

  let checkoutResult: { checkoutId: string; checkoutUrl: string };
  try {
    checkoutResult = await createCheckout(env, {
      orderNumber,
      amount: totalAmount,
      currency,
      returnUrl: returnUrl.toString(),
      ...(verifoneCustomerId ? { customer: verifoneCustomerId } : {}),
    });
  } catch (error) {
    console.error(JSON.stringify({ message: 'Verifone checkout creation failed', order_id: orderId }));
    await updateOrderStatus(env.DB, orderId, 'failed', { allowedFrom: ['pending'] });
    await failCheckoutAttempt(env.DB, keyHash);
    await logPaymentEvent(env.DB, {
      id: generateUUID(),
      orderId,
      eventType: 'checkout_creation_failed',
      source: 'verifone_api',
      rawPayload: JSON.stringify({ error_type: error instanceof Error ? error.name : 'unknown' }),
      verified: false,
    });
    return {
      status: 502,
      body: { error: 'Failed to create checkout session', code: 'checkout_provider_unavailable' },
    };
  }

  // Persist the provider URL immediately, before any other write, so a crash from
  // here on always leaves a checkout_url behind — the reclaim path above only ever
  // touches attempts where checkout_url is still null.
  await recordCheckoutUrl(env.DB, keyHash, checkoutResult.checkoutUrl);

  const applied = await updateOrderStatus(env.DB, orderId, 'checkout_created', {
    verifoneCheckoutId: checkoutResult.checkoutId,
    allowedFrom: ['pending'],
  });
  if (!applied) {
    await failCheckoutAttempt(env.DB, keyHash);
    throw new Error('Checkout order changed before session persistence');
  }

  await logPaymentEvent(env.DB, {
    id: generateUUID(),
    orderId,
    eventType: 'checkout_created',
    source: 'verifone_api',
    verifoneEventId: checkoutResult.checkoutId,
    rawPayload: JSON.stringify({
      checkoutId: checkoutResult.checkoutId,
      amount: totalAmount,
      currency,
      item_count: items.length,
    }),
    verified: true,
  });
  await completeCheckoutAttempt(env.DB, keyHash, checkoutResult.checkoutUrl);

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
