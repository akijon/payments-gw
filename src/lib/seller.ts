/**
 * Seller identity configuration.
 *
 * Seller info is read from Worker environment vars (set in wrangler.toml [vars]
 * or via `wrangler secret put`). All fields are legally required on Icelandic invoices.
 *
 * This module provides a fail-safe accessor: if any required field is missing,
 * it returns null — the invoice route then returns 503 (seller not configured).
 */

import type { Env } from '../types/env';
import type { SellerInfo } from '../types/invoice';

export function getSellerInfo(env: Env): SellerInfo | null {
  const name = env.SELLER_NAME;
  const kennitala = env.SELLER_KENNITALA;
  const vsk_number = env.SELLER_VSK_NUMBER;
  const address = env.SELLER_ADDRESS;
  const email = env.SELLER_EMAIL;
  const phone = env.SELLER_PHONE;

  if (!name || !kennitala || !vsk_number || !address || !email) {
    return null;
  }

  return { name, kennitala, vsk_number, address, email, phone: phone || undefined };
}
