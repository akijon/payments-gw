export interface CheckoutRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface CheckoutRateLimitInput {
  environment: string;
  clientIp?: string | null;
  limiter?: CheckoutRateLimiter;
}

export interface CheckoutRateLimitResult {
  allowed: boolean;
  status?: 400 | 429 | 503;
}

/**
 * Enforce a Cloudflare Rate Limiting binding on the public checkout endpoint.
 * Sandbox/test traffic remains unthrottled, while production fails closed if
 * its binding is absent or Cloudflare does not provide the client address.
 */
export async function enforceCheckoutRateLimit(input: CheckoutRateLimitInput): Promise<CheckoutRateLimitResult> {
  if (input.environment !== 'production') {
    return { allowed: true };
  }
  if (!input.clientIp) {
    return { allowed: false, status: 400 };
  }
  if (!input.limiter) {
    return { allowed: false, status: 503 };
  }

  const result = await input.limiter.limit({ key: input.clientIp });
  return result.success ? { allowed: true } : { allowed: false, status: 429 };
}
