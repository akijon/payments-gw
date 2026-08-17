/**
 * Terms-of-sale acceptance — server-side enforcement.
 *
 * The storefront checkbox is not proof of consent; the gateway validates that
 * the buyer explicitly accepted the exact terms version the storefront
 * displayed. Bump TERMS_VERSION whenever the storefront terms page content
 * changes — old acceptances must not silently bind the buyer to new terms.
 */
export const TERMS_VERSION = '2026-08-17';

export type TermsValidationResult =
  { ok: true } | { ok: false; code: 'terms_not_accepted' | 'terms_version_mismatch'; message: string };

export function validateTermsInput(value: unknown, version: unknown): TermsValidationResult {
  if (value !== true) {
    return {
      ok: false,
      code: 'terms_not_accepted',
      message: 'Terms of sale must be accepted',
    };
  }
  if (version !== TERMS_VERSION) {
    return {
      ok: false,
      code: 'terms_version_mismatch',
      message: 'Terms of sale version is outdated or missing',
    };
  }
  return { ok: true };
}
