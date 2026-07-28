/**
 * Shared API types for the Irja Payments Gateway
 */

// ─── Order types ─────────────────────────────────────────────────

export type OrderStatus =
  'pending' | 'checkout_created' | 'payment_pending' | 'paid' | 'failed' | 'refunded' | 'settled';

/**
 * Stored / response line item after catalog resolution.
 * unit_price and total_amount always come from the server catalog — never the client.
 */
export interface LineItem {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number; // minor units — from catalog
  total_amount: number; // minor units — unit_price * quantity
  sku?: string; // same as product_id when set
}

/**
 * Client checkout cart line. Only product identity + quantity are accepted.
 * Sending unit_price or total_amount is rejected as price manipulation.
 */
export interface CheckoutItemRequest {
  product_id?: string;
  sku?: string;
  quantity: number;
}

export interface Order {
  id: string;
  order_number: string;
  status: OrderStatus;
  currency: string;
  amount: number; // minor units
  customer_email?: string;
  customer_name?: string;
  items: LineItem[];
  verifone_checkout_id?: string;
  verifone_transaction_id?: string;
  landsbankinn_settlement_id?: string;
  created_at: string;
  updated_at: string;
  paid_at?: string;
  settled_at?: string;
}

// ─── Verifone types ──────────────────────────────────────────────

export interface VerifoneCheckoutRequest {
  entity_id: string;
  currency_code: string;
  amount: number;
  merchant_reference: string;
  return_url: string;
  interaction_type: 'HPP' | 'IFRAME' | 'PAYMENT_LINK';
  configurations: {
    card: {
      mode: 'PAYMENT' | '3DS_PAYMENT' | '3DS' | 'CARD_CAPTURE';
      payment_contract_id: string;
      capture_now: boolean;
      threed_secure?: {
        enabled: boolean;
        threeds_contract_id: string;
      };
    };
  };
}

export interface VerifoneCheckoutResponse {
  id: string;
  url: string;
  details?: {
    errors?: Array<Record<string, unknown>>;
  };
}

export interface VerifoneCheckoutEvent {
  type: string;
  id: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface VerifoneCheckoutDetail {
  id: string;
  status: string;
  events?: VerifoneCheckoutEvent[];
  transaction_id?: string;
  amount?: number;
  currency_code?: string;
  merchant_reference?: string;
}

// ─── Webhook types ───────────────────────────────────────────────

export interface VerifoneWebhookPayload {
  eventType: string;
  objectType: string;
  eventId: string;
  recordId: string;
  entityUid: string;
  eventDateTime: string;
  source: string;
  content?: {
    id?: string;
    amount?: number;
    currency_code?: string;
    transaction_type?: string;
    transaction_status?: string;
    payment_product?: string;
    payment_product_type?: string;
    reason_code?: string;
  };
}

// ─── Landsbankinn types ──────────────────────────────────────────

export interface LandsbankinnSettlement {
  id: string;
  settlementDate: string;
  totalAmount: number;
  currency: string;
  transactionCount: number;
}

export interface LandsbankinnTransaction {
  id: string;
  merchantReference?: string;
  amount: number;
  currency: string;
  transactionType: string;
  transactionStatus: string;
  settlementId?: string;
  createdAt: string;
}
