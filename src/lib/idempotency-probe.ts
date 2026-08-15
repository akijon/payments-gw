/**
 * Idempotency probe decision logic — pure functions extracted from
 * scripts/probe-verifone-idempotency.sh so the decision branches are
 * covered by Vitest (AGENTS.md hard rule: test-first).
 *
 * The bash script is a sandbox runner against the live Verifone API and
 * cannot run inside the Workers vitest pool. These functions encode the
 * same classification logic the script prints, keeping them in sync.
 */

export interface ProbeResponse {
  status: number;
  checkoutId: string;
}

export type BaselineResult = 'distinct' | 'implicit_dedupe' | 'inconclusive';

export type KeyBehavior = 'honored' | 'ignored' | 'inconclusive';

export type KeyScopeBehavior = 'conflict_rejected' | 'original_returned' | 'new_checkout';

export type RetentionResult = 'retained' | 'forgotten' | 'inconclusive';

/**
 * Baseline: two identical bodies, no idempotency key.
 * If both return the same checkout ID, merchant_reference already
 * deduplicates and the header question is moot — abort as inconclusive.
 */
export function classifyBaseline(r1: ProbeResponse, r2: ProbeResponse): BaselineResult {
  if (r1.checkoutId === '-' || r2.checkoutId === '-') {
    return 'inconclusive';
  }
  if (r1.checkoutId === r2.checkoutId) {
    return 'implicit_dedupe';
  }
  return 'distinct';
}

/**
 * Q1/Q2: same key, identical body, two requests.
 * Same checkout ID => header is honored; different => ignored.
 */
export function classifyKeyHonored(r1: ProbeResponse, r2: ProbeResponse): KeyBehavior {
  if (r1.checkoutId === '-' || r2.checkoutId === '-') {
    return 'inconclusive';
  }
  if (r1.checkoutId === r2.checkoutId) {
    return 'honored';
  }
  return 'ignored';
}

/**
 * Q3: same key, different body.
 * 4xx => conflict rejected (key scoped to body).
 * Same ID => original returned (amount silently ignored).
 * Different ID => new checkout (key not scoped to body — dangerous).
 */
export function classifyKeyScope(response: ProbeResponse, originalId: string): KeyScopeBehavior {
  if (response.status >= 400 && response.status < 500) {
    return 'conflict_rejected';
  }
  if (response.checkoutId === originalId) {
    return 'original_returned';
  }
  return 'new_checkout';
}

/**
 * Q4 retention: replay the exact original payload with the same key.
 * Same ID as original => retained; different ID => forgotten.
 * The replay MUST use the identical body (not a different merchant_reference)
 * so that a new checkout can only mean the key expired, not that the body
 * mismatched.
 */
export function classifyRetention(replay: ProbeResponse, originalId: string): RetentionResult {
  if (replay.checkoutId === '-') {
    return 'inconclusive';
  }
  if (replay.checkoutId === originalId) {
    return 'retained';
  }
  return 'forgotten';
}
