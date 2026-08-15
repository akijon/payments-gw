/**
 * Payment reconciliation and pricing mismatch resolution.
 *
 * Handles discrepancies between cart totals and gateway-authorized amounts,
 * including the 1-krona rounding drift adjustment and tamper detection.
 */

// Payment reconciliation utilities

export interface ReconciliationResult {
  status: 'exact_match' | 'rounding_adjusted' | 'TRANSACTION_ABORTED_PRICE_MISMATCH';
  adjustedAmount?: number;
  adjustmentReason?: string;
  largestVatLineIndex?: number;
}

/**
 * Reconcile cart total vs gateway authorized amount.
 * Implements the ±1 ISK rounding drift correction and tamper detection.
 */
export function reconcilePaymentAmounts(params: {
  cartGrossTotal: number; // Expected total from catalog
  gatewayAuthorizedAmount: number; // What was actually charged
  vatLineItems: Array<{
    total_amount: number;
    vat_rate: number;
    quantity: number;
  }>;
}): ReconciliationResult {
  const { cartGrossTotal, gatewayAuthorizedAmount, vatLineItems } = params;
  const discrepancy = Math.abs(cartGrossTotal - gatewayAuthorizedAmount);

  // Exact match - no adjustment needed
  if (discrepancy === 0) {
    return { status: 'exact_match' };
  }

  // Rounding drift (±1 ISK) - apply correction
  if (discrepancy === 100) {
    // 100 aurar = 1 ISK
    const correction = gatewayAuthorizedAmount - cartGrossTotal;

    // Find the largest 24% VAT item to absorb the drift
    let largestVatIndex = -1;
    let largestVatAmount = 0;

    for (let i = 0; i < vatLineItems.length; i++) {
      const item = vatLineItems[i];
      if (item.vat_rate === 24 && item.total_amount > largestVatAmount) {
        largestVatAmount = item.total_amount;
        largestVatIndex = i;
      }
    }

    if (largestVatIndex >= 0) {
      return {
        status: 'rounding_adjusted',
        adjustedAmount: gatewayAuthorizedAmount,
        adjustmentReason: `1-krona rounding drift (${correction > 0 ? '+' : ''}${correction / 100} ISK) absorbed by largest VAT item`,
        largestVatLineIndex: largestVatIndex,
      };
    }
  }

  // Discrepancy > 1 ISK indicates tampering or cache drift
  return {
    status: 'TRANSACTION_ABORTED_PRICE_MISMATCH',
    adjustmentReason: `Price mismatch: expected ${cartGrossTotal / 100} ISK, authorized ${gatewayAuthorizedAmount / 100} ISK (drift: ${discrepancy / 100} ISK)`,
  };
}

/**
 * Apply rounding adjustment to a specific line item.
 */
export function applyRoundingAdjustment(
  lineItem: { total_amount: number; vat_rate: number },
  adjustment: number,
): { total_amount: number; vat_rate: number } {
  return {
    ...lineItem,
    total_amount: lineItem.total_amount + adjustment,
  };
}

/**
 * Validate that all monetary amounts are within safe integer bounds
 * and currency codes are valid.
 */
export function validateMonetaryIntegrity(params: {
  amount: number;
  currency: string;
  lineItems?: Array<{ total_amount: number; unit_price: number; quantity: number }>;
}): { valid: boolean; error?: string } {
  const { amount, currency, lineItems } = params;

  // Check safe integer bounds
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { valid: false, error: 'Order amount exceeds safe integer bounds or is non-positive' };
  }

  // Validate currency format
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { valid: false, error: 'Currency code must be 3 uppercase letters' };
  }

  // Check line item integrity
  if (lineItems) {
    let computedTotal = 0;
    for (const item of lineItems) {
      if (
        !Number.isSafeInteger(item.total_amount) ||
        !Number.isSafeInteger(item.unit_price) ||
        !Number.isSafeInteger(item.quantity)
      ) {
        return { valid: false, error: 'Line item amounts exceed safe integer bounds' };
      }

      if (item.quantity <= 0) {
        return { valid: false, error: 'Line item quantity must be positive' };
      }

      computedTotal += item.total_amount;
    }

    if (Math.abs(computedTotal - amount) > 100) {
      // Allow ±1 ISK for rounding
      return { valid: false, error: 'Line item totals do not sum to order amount' };
    }
  }

  return { valid: true };
}
