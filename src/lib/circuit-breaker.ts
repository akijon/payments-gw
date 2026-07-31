/**
 * Lightweight circuit breaker for outbound Verifone/Landsbankinn calls.
 *
 * State is an in-memory Map per Worker isolate — this is a best-effort
 * mitigation against a cascading outage within a hot isolate, not a strict
 * distributed circuit breaker across all isolates/regions.
 */

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 30_000;

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const breakers = new Map<string, BreakerState>();

export class CircuitOpenError extends Error {
  constructor(public readonly key: string) {
    super(`Circuit breaker open for ${key}`);
    this.name = 'CircuitOpenError';
  }
}

function stateFor(key: string): BreakerState {
  let state = breakers.get(key);
  if (!state) {
    state = { failures: 0, openedAt: null };
    breakers.set(key, state);
  }
  return state;
}

/**
 * Run `fn`, tracking consecutive failures per `key`. After `FAILURE_THRESHOLD`
 * consecutive failures the breaker opens and rejects immediately with
 * `CircuitOpenError` for `COOLDOWN_MS`, then allows a half-open trial call.
 */
export async function withCircuitBreaker<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const state = stateFor(key);

  if (state.openedAt !== null && Date.now() - state.openedAt < COOLDOWN_MS) {
    throw new CircuitOpenError(key);
  }

  try {
    const result = await fn();
    state.failures = 0;
    state.openedAt = null;
    return result;
  } catch (error) {
    state.failures += 1;
    if (state.failures >= FAILURE_THRESHOLD) {
      state.openedAt = Date.now();
    }
    throw error;
  }
}

/** Test-only: clear all breaker state between test cases. */
export function __resetForTests(): void {
  breakers.clear();
}
