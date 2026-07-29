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
