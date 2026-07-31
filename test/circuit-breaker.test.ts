import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError, __resetForTests, withCircuitBreaker } from '../src/lib/circuit-breaker';

beforeEach(() => {
  __resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withCircuitBreaker', () => {
  it('passes through successful calls', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withCircuitBreaker('svc-a', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('propagates failures below the threshold and keeps calling fn', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 4; i++) {
      await expect(withCircuitBreaker('svc-b', fn)).rejects.toThrow('boom');
    }
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('opens after the failure threshold and short-circuits without calling fn', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('svc-c', fn)).rejects.toThrow('boom');
    }
    expect(fn).toHaveBeenCalledTimes(5);

    await expect(withCircuitBreaker('svc-c', fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('allows a half-open trial after the cooldown and closes the breaker on success', async () => {
    let currentTime = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('svc-d', fn)).rejects.toThrow('boom');
    }
    await expect(withCircuitBreaker('svc-d', fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(5);

    currentTime += 30_001; // past the cooldown window
    fn.mockResolvedValueOnce('recovered');
    await expect(withCircuitBreaker('svc-d', fn)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(6);

    // Breaker closed on the successful trial: a single subsequent failure alone
    // must not reopen it (failure count was reset).
    fn.mockRejectedValueOnce(new Error('boom again'));
    await expect(withCircuitBreaker('svc-d', fn)).rejects.toThrow('boom again');
    fn.mockResolvedValueOnce('still-closed');
    await expect(withCircuitBreaker('svc-d', fn)).resolves.toBe('still-closed');
  });

  it('keeps independent state per key', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    const succeeding = vi.fn().mockResolvedValue('ok');
    for (let i = 0; i < 5; i++) {
      await expect(withCircuitBreaker('svc-e', failing)).rejects.toThrow('boom');
    }
    await expect(withCircuitBreaker('svc-e', failing)).rejects.toThrow(CircuitOpenError);
    await expect(withCircuitBreaker('svc-f', succeeding)).resolves.toBe('ok');
  });
});
