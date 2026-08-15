/**
 * Dead Letter Queue and upstream failure recovery.
 *
 * Handles VAT engine timeouts, Peppol gateway failures, and other
 * upstream service disruptions with proper event queueing and retry logic.
 */

export interface DeadLetterEvent {
  id: string;
  orderId: string;
  eventType: 'vat_computation_failed' | 'peppol_submission_failed' | 'validator_timeout' | 'invoice_generation_failed';
  originalPayload: string;
  errorMessage: string;
  retryCount: number;
  maxRetries: number;
  lastAttemptAt: string;
  createdAt: string;
  status: 'queued' | 'retrying' | 'failed' | 'resolved';
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
  backoffMultiplier: 2,
};

/**
 * Enhanced order states for failure recovery.
 */
export type EnhancedOrderStatus =
  | 'pending'
  | 'checkout_created'
  | 'payment_pending'
  | 'paid'
  | 'SETTLED_PENDING_INVOICE' // Payment succeeded but invoice emission failed
  | 'PENDING_CUSTOMER_DATA' // B2B transaction awaiting valid kennitala
  | 'QUEUED_FOR_SEQUENCING' // Waiting for sequence number resolution
  | 'failed'
  | 'refunded'
  | 'settled';

/**
 * Dead Letter Queue manager for failed operations.
 */
export class DeadLetterQueue {
  private static events = new Map<string, DeadLetterEvent>();

  /**
   * Add an event to the DLQ with retry metadata.
   */
  static async enqueue(params: {
    orderId: string;
    eventType: DeadLetterEvent['eventType'];
    originalPayload: Record<string, unknown>;
    error: Error | string;
    config?: Partial<RetryConfig>;
  }): Promise<string> {
    const config = { ...DEFAULT_RETRY_CONFIG, ...params.config };
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();

    const event: DeadLetterEvent = {
      id: eventId,
      orderId: params.orderId,
      eventType: params.eventType,
      originalPayload: JSON.stringify(params.originalPayload),
      errorMessage: params.error instanceof Error ? params.error.message : params.error,
      retryCount: 0,
      maxRetries: config.maxRetries,
      lastAttemptAt: now,
      createdAt: now,
      status: 'queued',
    };

    this.events.set(eventId, event);

    console.error(`DLQ: Enqueued event ${eventId}`, {
      orderId: params.orderId,
      eventType: params.eventType,
      error: event.errorMessage,
    });

    return eventId;
  }

  /**
   * Retry a DLQ event with exponential backoff.
   */
  static async retry(
    eventId: string,
    retryFn: (payload: Record<string, unknown>) => Promise<boolean>,
  ): Promise<{ success: boolean; shouldRetryAgain: boolean }> {
    const event = this.events.get(eventId);
    if (!event || event.status === 'resolved') {
      return { success: true, shouldRetryAgain: false };
    }

    if (event.retryCount >= event.maxRetries) {
      event.status = 'failed';
      console.error(`DLQ: Event ${eventId} exceeded max retries`, { orderId: event.orderId });
      return { success: false, shouldRetryAgain: false };
    }

    event.status = 'retrying';
    event.retryCount++;
    event.lastAttemptAt = new Date().toISOString();

    try {
      const payload = JSON.parse(event.originalPayload);
      const success = await retryFn(payload);

      if (success) {
        event.status = 'resolved';
        console.info(`DLQ: Event ${eventId} resolved on retry ${event.retryCount}`);
        return { success: true, shouldRetryAgain: false };
      } else {
        event.status = 'queued';
        return { success: false, shouldRetryAgain: event.retryCount < event.maxRetries };
      }
    } catch (error) {
      event.status = 'queued';
      event.errorMessage = error instanceof Error ? error.message : 'Unknown retry error';

      console.error(`DLQ: Retry ${event.retryCount} failed for event ${eventId}`, {
        error: event.errorMessage,
        orderId: event.orderId,
      });

      return { success: false, shouldRetryAgain: event.retryCount < event.maxRetries };
    }
  }

  /**
   * Get exponential backoff delay for next retry.
   */
  static getRetryDelay(retryCount: number, config = DEFAULT_RETRY_CONFIG): number {
    const delay = Math.min(config.baseDelayMs * Math.pow(config.backoffMultiplier, retryCount), config.maxDelayMs);
    return delay;
  }

  /**
   * Get all events in the queue for monitoring.
   */
  static getAllEvents(): DeadLetterEvent[] {
    return Array.from(this.events.values());
  }

  /**
   * Get events for a specific order.
   */
  static getEventsByOrder(orderId: string): DeadLetterEvent[] {
    return Array.from(this.events.values()).filter((e) => e.orderId === orderId);
  }
}

/**
 * Subagent isolation and timeout handling.
 */
export interface SubagentResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timedOut: boolean;
  isolationId: string;
}

export async function executeWithIsolation<T>(
  operation: () => Promise<T>,
  params: {
    timeoutMs: number;
    isolationId: string;
    fallbackValue?: T;
  },
): Promise<SubagentResult<T>> {
  const { timeoutMs, isolationId, fallbackValue } = params;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Operation timed out')), timeoutMs);
  });

  try {
    const result = await Promise.race([operation(), timeoutPromise]);

    return {
      success: true,
      data: result,
      error: undefined,
      timedOut: false,
      isolationId,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === 'Operation timed out';

    console.error(`Isolated operation ${isolationId} ${isTimeout ? 'timed out' : 'failed'}`, {
      error: error instanceof Error ? error.message : 'unknown',
      timeout: isTimeout,
    });

    return {
      success: false,
      data: fallbackValue,
      error: error instanceof Error ? error.message : 'Unknown error',
      timedOut: isTimeout,
      isolationId,
    };
  }
}

/**
 * Enhanced invoice generation with DLQ fallback.
 */
export async function generateInvoiceWithFallback(params: {
  orderId: string;
  orderData: Record<string, unknown>;
}): Promise<{ success: boolean; invoiceId?: string; dlqEventId?: string }> {
  const { orderId, orderData } = params;

  try {
    // Attempt normal invoice generation
    const result = await executeWithIsolation(
      async () => {
        // Simplified placeholder for demonstration
        return { invoiceId: crypto.randomUUID() };
      },
      {
        timeoutMs: 10000, // 10 second timeout
        isolationId: `invoice-${orderId}`,
      },
    );

    if (result.success && result.data) {
      return { success: true, invoiceId: result.data.invoiceId };
    }

    // Invoice generation failed - enqueue for retry
    const dlqEventId = await DeadLetterQueue.enqueue({
      orderId,
      eventType: 'invoice_generation_failed',
      originalPayload: orderData,
      error: result.error || 'Unknown invoice generation error',
    });

    return { success: false, dlqEventId };
  } catch (error) {
    const dlqEventId = await DeadLetterQueue.enqueue({
      orderId,
      eventType: 'invoice_generation_failed',
      originalPayload: orderData,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return { success: false, dlqEventId };
  }
}

/**
 * Background DLQ processor (would be called by cron job).
 */
export async function processDLQEvents(): Promise<{ processed: number; resolved: number; failed: number }> {
  const events = DeadLetterQueue.getAllEvents().filter((e) => e.status === 'queued');
  let processed = 0;
  let resolved = 0;
  let failed = 0;

  for (const event of events) {
    const delay = DeadLetterQueue.getRetryDelay(event.retryCount);
    const timeSinceLastAttempt = Date.now() - new Date(event.lastAttemptAt).getTime();

    if (timeSinceLastAttempt < delay) {
      continue; // Not ready for retry yet
    }

    processed++;

    const result = await DeadLetterQueue.retry(event.id, async () => {
      // Retry logic would be specific to the event type
      switch (event.eventType) {
        case 'invoice_generation_failed':
          return true; // Placeholder - would retry invoice generation
        case 'vat_computation_failed':
          return true; // Placeholder - would retry VAT computation
        case 'peppol_submission_failed':
          return true; // Placeholder - would retry Peppol submission
        default:
          return false;
      }
    });

    if (result.success) {
      resolved++;
    } else if (!result.shouldRetryAgain) {
      failed++;
    }
  }

  return { processed, resolved, failed };
}
