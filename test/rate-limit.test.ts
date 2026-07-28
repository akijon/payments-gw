import { describe, expect, it } from 'vitest';
import { enforceCheckoutRateLimit } from '../src/lib/rate-limit';

describe('enforceCheckoutRateLimit', () => {
  it('fails closed in production when no rate-limit binding is configured', async () => {
    await expect(
      enforceCheckoutRateLimit({
        environment: 'production',
        clientIp: '203.0.113.10',
      }),
    ).resolves.toEqual({ allowed: false, status: 503 });
  });
});
