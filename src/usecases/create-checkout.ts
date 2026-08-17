/**
 * Create-checkout use case — framework-free (no Hono). Given already-validated
 * request fields, resolves catalog pricing, enforces idempotency, creates the
 * order, and creates the Verifone checkout session. The route adapter
 * (src/routes/checkout.ts) owns HTTP-shape concerns only: rate limiting,
 * header/JSON parsing, and rejecting client-controlled money fields.
 */

import type { Env } from '../types/env';
import type { CheckoutBillingDetails } from '../types/api';
import { CatalogError, resolveCheckoutItems } from '../lib/catalog';
import { TERMS_VERSION, validateTermsVersion } from '../lib/terms';

export interface CreateCheckoutInput {
  idempotencyKey: string;
  items: unknown;
  customerEmail?: string;
  customerName?: string;
  billing?: CheckoutBillingDetails;
  buyerKennitala?: string;
  /** Terms-of-sale consent; acceptance is validated by the route adapter and
   * the version is validated after idempotency lookup to preserve exact replays. */
  termsAccepted: true;
  termsVersion: unknown;
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
    reclaimCustomerCreationFailure,
    recordCheckoutProviderResult,
    renewCheckoutAttemptLease,
    setOrderVerifoneCustomerId,
  } = await import('../lib/db');

  const orderId = generateUUID();
  const orderNumber = generateOrderNumber();
  const keyHash = await hashIdempotencyValue(input.idempotencyKey);
  // Fingerprint the raw client request, not resolved catalog data: a product
  // rename/reprice/deactivation between the original attempt and a replay must
  // not turn a legitimate idempotent replay into a false conflict or catalog
  // error further down.
  const requestPayload = {
    items: input.items,
    customer_email: input.customerEmail ?? null,
    customer_name: input.customerName ?? null,
    billing: input.billing ?? null,
    buyer_kennitala: input.buyerKennitala ?? null,
    terms_accepted: input.termsAccepted,
    terms_version: input.termsVersion,
  };
  const requestHash = await hashIdempotencyValue(JSON.stringify(requestPayload));
  // Compatibility for exact replays created before billing became mandatory.
  // New attempts always use the current fingerprint and fail the customer gate.
  const legacyRequestHash = input.billing
    ? null
    : await hashIdempotencyValue(
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
  const termsVersion = validateTermsVersion(input.termsVersion);

  if (!claim.claimed) {
    const requestMatches =
      claim.attempt.request_hash === requestHash ||
      (legacyRequestHash !== null && claim.attempt.request_hash === legacyRequestHash);
    if (!requestMatches) {
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

    // A version bump must never create a new checkout or reclaim an incomplete
    // old attempt. Completed and recoverable provider replays returned above
    // remain valid because they use the consent already recorded with that order.
    if (!termsVersion.ok) {
      return { status: 400, body: { error: termsVersion.message, code: termsVersion.code } };
    }

    if (!input.customerEmail || !input.billing) {
      return {
        status: 400,
        body: {
          error: 'customer_email and complete billing details are required for 3DS checkout',
          code: 'customer_details_required',
        },
      };
    }

    // No checkout_url or recoverable provider result yet: either genuinely in
    // flight, previously failed, or the provider result was never committed
    // locally. The lease prevents a permanent key wedge, but provider
    // idempotency/reconciliation is still required because an accepted provider
    // request can exist without a locally stored result.
    const customerFailureReclaimed =
      claim.attempt.status === 'failed' &&
      (await reclaimCustomerCreationFailure(env.DB, { keyHash, requestHash, orderId }));
    const reclaim = customerFailureReclaimed
      ? { reclaimed: true }
      : await reclaimStaleCheckoutAttempt(env.DB, { keyHash, requestHash, orderId });
    if (!reclaim.reclaimed) {
      return {
        status: 409,
        body: { error: 'Checkout attempt is not reusable', code: `idempotency_${claim.attempt.status}` },
        headers: { 'Retry-After': claim.attempt.status === 'processing' ? '2' : '0' },
      };
    }
    // Reclaimed: fall through and create a fresh checkout for `orderId`.
  }

  if (!termsVersion.ok) {
    await failCheckoutAttempt(env.DB, keyHash);
    return { status: 400, body: { error: termsVersion.message, code: termsVersion.code } };
  }

  if (!input.customerEmail || !input.billing) {
    await failCheckoutAttempt(env.DB, keyHash);
    return {
      status: 400,
      body: {
        error: 'customer_email and complete billing details are required for 3DS checkout',
        code: 'customer_details_required',
      },
    };
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
      billing: input.billing,
      buyerKennitala: input.buyerKennitala,
      termsAcceptedAt: new Date().toISOString(),
      termsVersion: TERMS_VERSION,
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

  let verifoneCustomerId: string | undefined;
  if (input.customerEmail && input.billing) {
    try {
      verifoneCustomerId = await createCustomer(env, {
        email: input.customerEmail,
        firstName: input.billing.first_name,
        lastName: input.billing.last_name,
        billingAddress1: input.billing.address_1,
        billingCity: input.billing.city,
        billingCountryCode: input.billing.country_code,
        billingPostalCode: input.billing.postal_code,
        ...(input.billing.state ? { billingState: input.billing.state } : {}),
        ...(input.billing.phone ? { billingPhone: input.billing.phone } : {}),
      });
      await setOrderVerifoneCustomerId(env.DB, orderId, verifoneCustomerId);
    } catch (error) {
      console.error(JSON.stringify({ message: 'Verifone createCustomer failed', order_id: orderId }));
      const failed = await failCheckoutCreationAtomically(env.DB, {
        keyHash,
        orderId,
        eventId: generateUUID(),
        eventType: 'customer_creation_failed',
        rawPayload: JSON.stringify({ error_type: error instanceof Error ? error.name : 'unknown' }),
      });
      if (!failed) throw new Error('Checkout order changed before customer failure persistence');
      return {
        status: 502,
        body: { error: 'Failed to create payment customer', code: 'customer_provider_unavailable' },
      };
    }
  }

  // Customer lookup + creation can consume two 15-second upstream windows.
  // Renew ownership before the subsequent checkout POST so a same-key retry
  // cannot reclaim the 45-second lease while this request still owns it.
  const leaseRenewed = await renewCheckoutAttemptLease(env.DB, { keyHash, orderId });
  if (!leaseRenewed) {
    throw new Error('Checkout attempt lease lost before provider checkout creation');
  }

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
