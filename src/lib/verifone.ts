/**
 * Verifone API client — Basic Auth, checkout creation, checkout verification
 */

import type { Env } from '../types/env';
import type {
  PaymentMethod,
  ThreeDSAuthenticationIndicator,
  ThreeDSChallengeIndicator,
  VerifoneBilling,
  VerifoneCheckoutConfigurations,
  VerifoneCheckoutDetail,
  VerifoneCheckoutRequest,
  VerifoneCheckoutResponse,
} from '../types/api';
import { withCircuitBreaker } from './circuit-breaker';
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_DYNAMIC_DESCRIPTOR_LENGTH = 25;

export interface BuildVerifoneCheckoutRequestParams {
  orderNumber: string;
  amount: number; // whole krónur (ISK major units)
  currency: string; // ISO 4217 uppercase, e.g. "ISK"
  returnUrl: string;
  /**
   * Storefront URL Verifone redirects to when the shopper cancels the HPP.
   * Verifone exposes no `cancel_url`; `shop_url` is the documented equivalent.
   */
  shopUrl?: string;
  /** Pre-created Verifone customer ID (see createCustomer) to attach for richer 3DS customer_details. */
  customer?: string;
  /** Short text shown on the cardholder's bank statement. Verifone caps this at 25 chars. */
  dynamicDescriptor?: string;
  authenticationIndicator?: ThreeDSAuthenticationIndicator;
  challengeIndicator?: ThreeDSChallengeIndicator;
}

function upstreamError(operation: string, response: Response): Error {
  return new Error(`${operation} failed with HTTP ${response.status}`);
}

/** Build Verifone's documented RFC 7617 user-UUID/API-key credential. */
export function buildVerifoneAuthorization(env: Env): string {
  const userId = env.VERIFONE_USER_ID?.trim();
  const apiKey = env.VERIFONE_API_KEY?.trim();
  const printableAscii = /^[\x21-\x7e]+$/;
  if (!userId || !apiKey || userId.includes(':') || !printableAscii.test(userId) || !printableAscii.test(apiKey)) {
    throw new Error('Invalid Verifone Basic Auth credentials');
  }
  return `Basic ${btoa(`${userId}:${apiKey}`)}`;
}

/** Absolute, parseable, and https — the only shape safe to hand a shopper as a redirect target. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Non-empty after trim → usable contract ID; otherwise treat as unset. */
function configuredContractId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalize Verifone payment_product value to PaymentMethod enum.
 * Maps provider-specific values to standardized types for database storage.
 */
export function normalizePaymentMethod(paymentProduct?: string): PaymentMethod {
  if (!paymentProduct) return 'unknown';

  const product = paymentProduct.toUpperCase().trim();

  switch (product) {
    case 'PAYPAL':
      return 'paypal';
    case 'APPLEPAY':
    case 'APPLE_PAY':
      return 'apple_pay';
    case 'GOOGLEPAY':
    case 'GOOGLE_PAY':
      return 'google_pay';
    case 'VISA':
    case 'MASTERCARD':
    case 'AMEX':
    case 'AMERICANEXPRESS':
    case 'DISCOVER':
    case 'JCB':
    case 'DINERS':
    case 'MAESTRO':
      return 'card';
    default:
      // Never route an unrecognized provider product through card settlement.
      return 'unknown';
  }
}

/**
 * Pure Verifone HPP checkout request builder.
 *
 * Card is always included from the existing PPC + 3DS contracts.
 * Apple Pay and Google Pay are env-gated and fail-closed: omit the key unless
 * a non-empty acquirer contract ID is provisioned. PayPal stays suppressed
 * until both currency support and an operational settlement path exist.
 */
export function buildVerifoneCheckoutRequest(
  env: Env,
  params: BuildVerifoneCheckoutRequestParams,
): VerifoneCheckoutRequest {
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0 || !/^[A-Z]{3}$/.test(params.currency)) {
    throw new Error('Invalid checkout amount or currency');
  }
  if (params.dynamicDescriptor && params.dynamicDescriptor.length > MAX_DYNAMIC_DESCRIPTOR_LENGTH) {
    throw new Error(`dynamicDescriptor exceeds Verifone's ${MAX_DYNAMIC_DESCRIPTOR_LENGTH}-character limit`);
  }
  if (params.shopUrl !== undefined && !isHttpsUrl(params.shopUrl)) {
    throw new Error('shopUrl must be an absolute https URL');
  }

  const configurations: VerifoneCheckoutConfigurations = {
    card: {
      mode: '3DS_PAYMENT',
      payment_contract_id: env.VERIFONE_PAYMENT_CONTRACT_ID,
      capture_now: true,
      threed_secure: {
        enabled: true,
        threeds_contract_id: env.VERIFONE_3DS_CONTRACT_ID,
        transaction_mode: 'S',
        ...(params.authenticationIndicator ? { authentication_indicator: params.authenticationIndicator } : {}),
        ...(params.challengeIndicator ? { challenge_indicator: params.challengeIndicator } : {}),
      },
    },
  };

  if (params.dynamicDescriptor) {
    configurations.card.dynamic_descriptor = params.dynamicDescriptor;
  }

  const applePayContractId = configuredContractId(env.VERIFONE_APPLE_PAY_PAYMENT_CONTRACT_ID);
  if (applePayContractId) {
    configurations.apple_pay = { payment_contract_id: applePayContractId };
  }

  const googlePayContractId = configuredContractId(env.VERIFONE_GOOGLE_PAY_PAYMENT_CONTRACT_ID);
  if (googlePayContractId) {
    configurations.google_pay = { payment_contract_id: googlePayContractId };
  }

  return {
    entity_id: env.VERIFONE_ENTITY_ID,
    currency_code: params.currency,
    amount: params.amount,
    merchant_reference: params.orderNumber,
    return_url: params.returnUrl,
    ...(params.shopUrl ? { shop_url: params.shopUrl } : {}),
    interaction_type: 'HPP',
    ...(params.customer ? { customer: params.customer } : {}),
    configurations,
  };
}

// ─── Create checkout session ────────────────────────────────────

export async function createCheckout(
  env: Env,
  params: BuildVerifoneCheckoutRequestParams,
): Promise<{ checkoutId: string; checkoutUrl: string }> {
  // Validation + configurations live in the pure builder so unit tests can
  // pin HPP method gating without mocking fetch/authentication.
  const body = buildVerifoneCheckoutRequest(env, params);
  const authorization = buildVerifoneAuthorization(env);

  const resp = await withCircuitBreaker('verifone', () =>
    fetch(`${env.VERIFONE_API_BASE}/v2/checkout`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: '*/*',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }),
  );

  if (!resp.ok) {
    throw upstreamError('Verifone createCheckout', resp);
  }

  const data = (await resp.json()) as VerifoneCheckoutResponse;
  let checkoutUrl: URL;
  try {
    checkoutUrl = new URL(data.url);
  } catch {
    throw new Error('Verifone createCheckout returned an invalid URL');
  }
  if (
    typeof data.id !== 'string' ||
    data.id.length === 0 ||
    data.id.length > 256 ||
    checkoutUrl.protocol !== 'https:' ||
    data.url.length > 2048
  ) {
    throw new Error('Verifone createCheckout returned an invalid response');
  }
  return { checkoutId: data.id, checkoutUrl: data.url };
}

// ─── Create customer (Customer API) ─────────────────────────────

export interface CreateCustomerParams {
  email: string;
  firstName: string;
  lastName: string;
  billingAddress1: string;
  billingCity: string;
  billingCountryCode: string;
  billingPostalCode: string;
  billingState?: string;
  billingPhone?: string;
}

interface VerifoneCustomerRecord {
  id?: unknown;
  entity_id?: unknown;
  email_address?: unknown;
  billing?: Partial<VerifoneBilling>;
}

function rsqlQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isMatchingCustomer(record: VerifoneCustomerRecord, env: Env, params: CreateCustomerParams): boolean {
  const billing = record.billing;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id.length <= 256 &&
    record.entity_id === env.VERIFONE_ENTITY_ID &&
    typeof record.email_address === 'string' &&
    record.email_address.toLowerCase() === params.email.toLowerCase() &&
    billing?.first_name === params.firstName &&
    billing.last_name === params.lastName &&
    billing.address_1 === params.billingAddress1 &&
    billing.city === params.billingCity &&
    billing.country_code === params.billingCountryCode &&
    billing.postal_code === params.billingPostalCode &&
    (billing.state ?? undefined) === params.billingState &&
    (billing.phone ?? undefined) === params.billingPhone
  );
}

export async function createCustomer(env: Env, params: CreateCustomerParams): Promise<string> {
  if (!params.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.email)) {
    throw new Error('Invalid customer email');
  }
  if (
    !params.firstName?.trim() ||
    params.firstName.length > 22 ||
    !params.lastName?.trim() ||
    params.lastName.length > 22 ||
    !params.billingAddress1?.trim() ||
    params.billingAddress1.length > 40 ||
    !params.billingCity?.trim() ||
    params.billingCity.length > 28 ||
    !params.billingPostalCode?.trim() ||
    params.billingPostalCode.length > 10 ||
    !/^[A-Z]{2}$/.test(params.billingCountryCode) ||
    (params.billingState !== undefined && (!params.billingState.trim() || params.billingState.length > 35)) ||
    (params.billingPhone !== undefined && !/^\+?[0-9]{7,25}$/.test(params.billingPhone))
  ) {
    throw new Error('Missing or invalid Verifone customer billing fields');
  }
  const authorization = buildVerifoneAuthorization(env);
  const customerEndpoint = `${env.VERIFONE_API_BASE.replace('/checkout-service', '/customer-service')}/v2/customer`;

  // Customer creation has no documented idempotency key. Recover accepted-but-
  // timed-out creates and reuse prior exact profiles before issuing another POST.
  const listUrl = new URL(customerEndpoint);
  listUrl.searchParams.set(
    'search',
    `email_address==${rsqlQuoted(params.email)};entity_id==${rsqlQuoted(env.VERIFONE_ENTITY_ID)}`,
  );
  listUrl.searchParams.set('page_size', '50');
  listUrl.searchParams.set('page_number', '1');
  const listResponse = await withCircuitBreaker('verifone-customer', () =>
    fetch(listUrl.toString(), {
      method: 'GET',
      headers: { Authorization: authorization, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }),
  );
  if (!listResponse.ok) throw upstreamError('Verifone listCustomers', listResponse);
  const customers = (await listResponse.json()) as unknown;
  if (!Array.isArray(customers) || customers.length > 50) {
    throw new Error('Verifone listCustomers returned an invalid response');
  }
  const existing = customers.find((customer) => isMatchingCustomer(customer as VerifoneCustomerRecord, env, params));
  if (existing && typeof (existing as VerifoneCustomerRecord).id === 'string') {
    return (existing as VerifoneCustomerRecord).id as string;
  }

  // Verifone's Customer API schema has no top-level first_name/last_name or
  // email fields — those live at email_address and billing.first_name/last_name.
  const billing: VerifoneBilling = {
    first_name: params.firstName,
    last_name: params.lastName,
    address_1: params.billingAddress1,
    city: params.billingCity,
    country_code: params.billingCountryCode,
    postal_code: params.billingPostalCode,
    ...(params.billingState ? { state: params.billingState } : {}),
    ...(params.billingPhone ? { phone: params.billingPhone } : {}),
  };

  const body = {
    entity_id: env.VERIFONE_ENTITY_ID,
    email_address: params.email,
    billing,
  };

  const resp = await withCircuitBreaker('verifone-customer', () =>
    fetch(customerEndpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: '*/*',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }),
  );

  if (!resp.ok) {
    throw upstreamError('Verifone createCustomer', resp);
  }

  const data = (await resp.json()) as { id?: unknown };
  if (typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error('Verifone createCustomer returned an invalid response');
  }
  return data.id;
}

// ─── Read checkout (verify payment) ─────────────────────────────

export async function getCheckout(env: Env, checkoutId: string): Promise<VerifoneCheckoutDetail> {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(checkoutId)) {
    throw new Error('Invalid Verifone checkout ID');
  }
  const authorization = buildVerifoneAuthorization(env);

  const resp = await withCircuitBreaker('verifone', () =>
    fetch(`${env.VERIFONE_API_BASE}/v2/checkout/${encodeURIComponent(checkoutId)}`, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }),
  );

  if (!resp.ok) {
    throw upstreamError('Verifone getCheckout', resp);
  }

  return (await resp.json()) as VerifoneCheckoutDetail;
}

// ─── Extract payment status from checkout ────────────────────────

// Reason codes for API transactions (Verifone docs) that specifically indicate
// an SCA/3DS authentication step, as opposed to a plain card decline:
// 1813 SCA - PIN required · 1815 Additional customer authentication required
// (CDCVM/Passcode/Biometric) · 1816 Acquirer requested SCA action not supported
// · 1824 Invalid use of SCA Exemption Indicators · 1836 SCA Exemption Soft
// Decline (Transaction Risk Analysis service not available).
const SCA_REASON_CODES = new Set(['1813', '1815', '1816', '1824', '1836']);

export interface CheckoutPaymentResult {
  status: 'success' | 'failed' | 'pending';
  transactionId?: string;
  /** Only set when status is 'failed'. Distinguishes an SCA/3DS authentication failure from a plain decline. */
  failureReason?: 'authentication_required' | 'declined';
}

export function parseCheckoutResult(detail: VerifoneCheckoutDetail): CheckoutPaymentResult {
  const events = detail.events ?? [];
  const successEvent = events.find((e) => e.type === 'TRANSACTION_SUCCESS');
  const failedEvent = events.find((e) => e.type === 'TRANSACTION_FAILED');

  if (successEvent) {
    return { status: 'success', transactionId: successEvent.id };
  }
  if (failedEvent) {
    const reasonCode = failedEvent.details?.reason_code;
    const failureReason: CheckoutPaymentResult['failureReason'] =
      typeof reasonCode === 'string' && SCA_REASON_CODES.has(reasonCode) ? 'authentication_required' : 'declined';
    return { status: 'failed', transactionId: failedEvent.id, failureReason };
  }
  return { status: 'pending' };
}
