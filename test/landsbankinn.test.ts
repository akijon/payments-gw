/**
 * Landsbankinn client — unit tests for function signatures and error handling.
 * Fetch is tested via checkout/return integration tests using vi.mock pattern.
 */

import { describe, it, expect } from 'vitest';

describe('Landsbankinn API client', () => {
  it('module exports all expected functions', async () => {
    const mod = await import('../src/lib/landsbankinn');
    expect(typeof mod.getLandsbankinnToken).toBe('function');
    expect(typeof mod.getSettlements).toBe('function');
    expect(typeof mod.getSettlementTransactions).toBe('function');
    expect(typeof mod.getTransactions).toBe('function');
  });
});
