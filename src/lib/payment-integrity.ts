import type { VerifoneCheckoutDetail } from '../types/api';

export type PaymentIntegrityCode =
  | 'checkout_id_mismatch'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'merchant_reference_mismatch'
  | 'missing_transaction_id'
  | 'refund_verification_mismatch';

export class PaymentIntegrityError extends Error {
  constructor(
    public readonly code: PaymentIntegrityCode,
    public readonly details: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'PaymentIntegrityError';
  }
}

export type PricingIntegrityCode = 'pricing_mismatch' | 'pricing_malformed';

/** Raised when the charged amount does not reconcile with the invoice arithmetic. */
export class PricingIntegrityError extends Error {
  constructor(
    public readonly code: PricingIntegrityCode,
    public readonly details: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'PricingIntegrityError';
  }
}

export interface PricingComponents {
  /** What the payment gateway actually charged, in minor units. */
  chargedAmount: number;
  subtotalExclVat: number;
  totalVat: number;
  /** Shipping is VAT-inclusive, matching the VAT-inclusive catalog pricing. */
  shippingInclVat: number;
}

/**
 * Fail closed unless the gateway charge strictly equals
 * `subtotal_excl_vat + total_vat + shipping_incl_vat`.
 *
 * computeInvoice already asserts the invoice agrees with itself; this asserts
 * the invoice agrees with the money actually taken from the customer. An
 * invoice finalized for an amount the customer was never charged is the exact
 * discrepancy a Skatturinn audit surfaces, so both directions (under- and
 * overcharge) are blocked.
 */
export function assertPricingIntegrity(components: PricingComponents): void {
  const { chargedAmount, subtotalExclVat, totalVat, shippingInclVat } = components;

  const malformed =
    !Number.isSafeInteger(chargedAmount) ||
    !Number.isSafeInteger(subtotalExclVat) ||
    !Number.isSafeInteger(totalVat) ||
    !Number.isSafeInteger(shippingInclVat) ||
    chargedAmount <= 0 ||
    subtotalExclVat < 0 ||
    totalVat < 0 ||
    shippingInclVat < 0;

  if (malformed) {
    throw new PricingIntegrityError('pricing_malformed', {
      charged_amount: chargedAmount,
      subtotal_excl_vat: subtotalExclVat,
      total_vat: totalVat,
      shipping_incl_vat: shippingInclVat,
    });
  }

  const computedTotal = subtotalExclVat + totalVat + shippingInclVat;
  if (chargedAmount !== computedTotal) {
    throw new PricingIntegrityError('pricing_mismatch', {
      charged_amount: chargedAmount,
      computed_total: computedTotal,
      subtotal_excl_vat: subtotalExclVat,
      total_vat: totalVat,
      shipping_incl_vat: shippingInclVat,
      difference: chargedAmount - computedTotal,
    });
  }
}

export interface ExpectedCheckout {
  checkoutId: string;
  amount: number;
  currency: string;
  merchantReference: string;
  requireTransactionId?: boolean;
}

/** Fail closed when Verifone omits or changes any field that binds payment to an order. */
export function assertCheckoutIntegrity(detail: VerifoneCheckoutDetail, expected: ExpectedCheckout): void {
  if (detail.id !== expected.checkoutId) {
    throw new PaymentIntegrityError('checkout_id_mismatch', {
      expected_checkout_id: expected.checkoutId,
      received_checkout_id: detail.id,
    });
  }

  if (!Number.isSafeInteger(detail.amount) || detail.amount !== expected.amount) {
    throw new PaymentIntegrityError('amount_mismatch', {
      expected_amount: expected.amount,
      received_amount: detail.amount ?? null,
    });
  }

  if (detail.currency_code !== expected.currency) {
    throw new PaymentIntegrityError('currency_mismatch', {
      expected_currency: expected.currency,
      received_currency: detail.currency_code ?? null,
    });
  }

  if (detail.merchant_reference !== expected.merchantReference) {
    throw new PaymentIntegrityError('merchant_reference_mismatch', {
      expected_merchant_reference: expected.merchantReference,
      received_merchant_reference: detail.merchant_reference ?? null,
    });
  }

  if (expected.requireTransactionId && !detail.transaction_id) {
    throw new PaymentIntegrityError('missing_transaction_id', {});
  }
}
