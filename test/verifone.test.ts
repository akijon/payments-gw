/**
 * Verifone API client — unit tests
 *
 * Tests parseCheckoutResult (pure function, no fetch needed).
 * For fetch-dependent functions, see checkout.test.ts which tests via SELF + vi.mock.
 */

import { describe, it, expect } from 'vitest';
import { parseCheckoutResult } from '../src/lib/verifone';

describe('parseCheckoutResult', () => {
  it('returns success with transaction ID for TRANSACTION_SUCCESS', () => {
    const detail = {
      id: 'chk-1',
      status: 'COMPLETED',
      events: [{ type: 'TRANSACTION_SUCCESS', id: 'txn-s1', timestamp: '2026-07-25T10:00:00Z' }],
    };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('success');
    expect(result.transactionId).toBe('txn-s1');
  });

  it('returns failed for TRANSACTION_FAILED', () => {
    const detail = {
      id: 'chk-2',
      status: 'FAILED',
      events: [{ type: 'TRANSACTION_FAILED', id: 'txn-f1', timestamp: '2026-07-25T10:00:00Z' }],
    };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('failed');
    expect(result.transactionId).toBe('txn-f1');
  });

  it('returns pending when no events', () => {
    const detail = { id: 'chk-3', status: 'PENDING', events: [] };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('pending');
    expect(result.transactionId).toBeUndefined();
  });

  it('returns pending when events undefined', () => {
    const detail = { id: 'chk-4', status: 'PENDING' };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('pending');
  });

  it('prioritizes success over failure', () => {
    const detail = {
      id: 'chk-5',
      status: 'COMPLETED',
      events: [
        { type: 'TRANSACTION_FAILED', id: 'f-early', timestamp: '2026-07-25T09:00:00Z' },
        { type: 'TRANSACTION_SUCCESS', id: 's-late', timestamp: '2026-07-25T10:00:00Z' },
      ],
    };
    const result = parseCheckoutResult(detail);
    expect(result.status).toBe('success');
    expect(result.transactionId).toBe('s-late');
  });
});
