/**
 * Idempotency probe decision logic — tests
 *
 * Covers the pure classification functions extracted from
 * scripts/probe-verifone-idempotency.sh. The bash script itself runs
 * against the live sandbox and cannot be executed in the Workers vitest
 * pool; these tests pin the decision branches the script relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyBaseline,
  classifyKeyHonored,
  classifyKeyScope,
  classifyRetention,
  type ProbeResponse,
} from '../src/lib/idempotency-probe';

const resp = (status: number, checkoutId: string): ProbeResponse => ({ status, checkoutId });

describe('classifyBaseline', () => {
  it('returns distinct when two identical bodies produce different checkout IDs', () => {
    expect(classifyBaseline(resp(200, 'chk-a'), resp(200, 'chk-b'))).toBe('distinct');
  });

  it('returns implicit_dedupe when both return the same checkout ID', () => {
    expect(classifyBaseline(resp(200, 'chk-same'), resp(200, 'chk-same'))).toBe('implicit_dedupe');
  });

  it('returns inconclusive when either response has no checkout ID', () => {
    expect(classifyBaseline(resp(200, '-'), resp(200, 'chk-b'))).toBe('inconclusive');
    expect(classifyBaseline(resp(200, 'chk-a'), resp(200, '-'))).toBe('inconclusive');
  });
});

describe('classifyKeyHonored', () => {
  it('returns honored when replay returns the original checkout ID', () => {
    expect(classifyKeyHonored(resp(200, 'chk-1'), resp(200, 'chk-1'))).toBe('honored');
  });

  it('returns ignored when replay creates a second checkout', () => {
    expect(classifyKeyHonored(resp(200, 'chk-1'), resp(200, 'chk-2'))).toBe('ignored');
  });

  it('returns inconclusive when either response has no checkout ID', () => {
    expect(classifyKeyHonored(resp(200, '-'), resp(200, 'chk-1'))).toBe('inconclusive');
  });
});

describe('classifyKeyScope', () => {
  it('returns conflict_rejected for 4xx', () => {
    expect(classifyKeyScope(resp(409, '-'), 'chk-1')).toBe('conflict_rejected');
    expect(classifyKeyScope(resp(422, '-'), 'chk-1')).toBe('conflict_rejected');
  });

  it('returns original_returned when response matches original ID', () => {
    expect(classifyKeyScope(resp(200, 'chk-1'), 'chk-1')).toBe('original_returned');
  });

  it('returns new_checkout when response has a different ID', () => {
    expect(classifyKeyScope(resp(200, 'chk-2'), 'chk-1')).toBe('new_checkout');
  });
});

describe('classifyRetention', () => {
  it('returns retained when replay returns the original checkout ID', () => {
    expect(classifyRetention(resp(200, 'chk-orig'), 'chk-orig')).toBe('retained');
  });

  it('returns forgotten when replay returns a new checkout ID', () => {
    expect(classifyRetention(resp(200, 'chk-new'), 'chk-orig')).toBe('forgotten');
  });

  it('returns inconclusive when response has no checkout ID', () => {
    expect(classifyRetention(resp(200, '-'), 'chk-orig')).toBe('inconclusive');
  });
});
