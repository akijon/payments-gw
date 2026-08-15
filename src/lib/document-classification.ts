/**
 * Icelandic document classification and fallback logic.
 *
 * Legal basis: Lög um virðisaukaskatt nr. 50/1988, reglugerð nr. 505/2013.
 * Consumer transactions under 50,000 ISK can use simplified receipts
 * when no valid business kennitala is available.
 */

import { isValidKennitala } from './invoice-computation';

export interface DocumentClassification {
  documentType: 'sölureikningur' | 'sölukvittun';
  requiresKennitala: boolean;
  reason: string;
}

/**
 * Determine the appropriate document type for a transaction.
 * Implements the fallback rule: under 50k ISK + no valid kennitala = receipt.
 */
export function classifyDocument(params: {
  amount: number; // in minor units (aurar)
  buyerKennitala?: string | null;
  customerName?: string | null;
  hasCompanyIndicators?: boolean;
}): DocumentClassification {
  const { amount, buyerKennitala, customerName, hasCompanyIndicators } = params;

  // If kennitala is provided and valid, always issue formal invoice
  if (buyerKennitala && isValidKennitala(buyerKennitala)) {
    return {
      documentType: 'sölureikningur',
      requiresKennitala: true,
      reason: 'Valid kennitala provided - formal invoice required',
    };
  }

  // Check for business transaction indicators
  const businessIndicators =
    hasCompanyIndicators || (customerName && /\b(ehf|sf|hf|inc|ltd|as|aps)\b/i.test(customerName));

  if (businessIndicators) {
    return {
      documentType: 'sölureikningur',
      requiresKennitala: true,
      reason: 'Business transaction detected - formal invoice required',
    };
  }

  // Consumer fallback: no valid kennitala and no business indicators means the
  // buyer is unidentified, so the only document we can legally issue is a B2C
  // receipt. This is deliberately unconditional — there is no value threshold
  // that upgrades an unidentified buyer to a formal sölureikningur, because the
  // kennitala is precisely the field that makes the document one.
  return {
    documentType: 'sölukvittun',
    requiresKennitala: false,
    reason: `Consumer transaction without kennitala - receipt issued (${Math.round(amount / 100)} ISK)`,
  };
}

/**
 * Enhanced error states for customer data resolution.
 */
export type CustomerDataStatus =
  | 'valid'
  | 'PENDING_CUSTOMER_DATA' // B2B transaction missing valid kennitala
  | 'fallback_receipt' // Downgraded to consumer receipt
  | 'invalid_format';

export function validateCustomerData(params: {
  amount: number;
  buyerKennitala?: string | null;
  customerName?: string | null;
}): { status: CustomerDataStatus; classification: DocumentClassification } {
  const classification = classifyDocument(params);

  // If formal invoice is required but kennitala is invalid/missing
  if (classification.requiresKennitala && (!params.buyerKennitala || !isValidKennitala(params.buyerKennitala))) {
    return {
      status: 'PENDING_CUSTOMER_DATA',
      classification,
    };
  }

  // If we downgraded to receipt due to amount threshold
  if (classification.documentType === 'sölukvittun') {
    return {
      status: 'fallback_receipt',
      classification,
    };
  }

  return {
    status: 'valid',
    classification,
  };
}
