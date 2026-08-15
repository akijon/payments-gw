/**
 * Sequential invoice number conflict resolution and queueing.
 *
 * Handles D1 sequence collisions, gaps, and race conditions to ensure
 * compliance with Icelandic accounting law (órofin númeraröð).
 *
 * Legal basis: Act No. 145/1994, Reg. No. 505/2013 - sequential numbering required.
 */

export interface SequenceState {
  status: 'available' | 'QUEUED_FOR_SEQUENCING' | 'sequence_error';
  queuePosition?: number;
  estimatedWaitMs?: number;
  error?: string;
}

export interface QueuedOrder {
  orderId: string;
  requestedAt: string;
  priority: 'normal' | 'high';
  documentType: 'invoice' | 'credit_note';
}

/**
 * Enhanced sequence claiming with deadlock detection and recovery.
 */
export async function claimSequenceWithRetry(
  db: D1Database,
  params: {
    sequenceType: 'invoice' | 'credit_note';
    year: number;
    maxRetries?: number;
    backoffMs?: number;
  },
): Promise<{ success: boolean; sequenceNumber?: number; queueState?: SequenceState }> {
  const { sequenceType, year, maxRetries = 3, backoffMs = 50 } = params;

  const tableName = sequenceType === 'invoice' ? 'invoice_sequence' : 'credit_note_sequence';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Attempt atomic sequence claim
      await db
        .prepare(
          `
        INSERT OR IGNORE INTO ${tableName} (year, next_number) VALUES (?, 1);
      `,
        )
        .bind(year)
        .run();

      const claimed = await db
        .prepare(
          `
        UPDATE ${tableName} 
        SET next_number = next_number + 1 
        WHERE year = ? 
        RETURNING next_number - 1 AS sequence
      `,
        )
        .bind(year)
        .first<{ sequence: number }>();

      if (claimed && Number.isInteger(claimed.sequence) && claimed.sequence >= 1) {
        return { success: true, sequenceNumber: claimed.sequence };
      }

      // Sequence claim failed - check for gaps or corruption
      const currentState = await db
        .prepare(
          `
        SELECT next_number FROM ${tableName} WHERE year = ?
      `,
        )
        .bind(year)
        .first<{ next_number: number }>();

      if (!currentState) {
        throw new Error(`Sequence table ${tableName} corrupted for year ${year}`);
      }
    } catch (error) {
      console.error(`Sequence claim attempt ${attempt}/${maxRetries} failed:`, error);

      if (attempt === maxRetries) {
        return {
          success: false,
          queueState: {
            status: 'sequence_error',
            error: `Failed to claim sequence after ${maxRetries} attempts: ${error instanceof Error ? error.message : 'unknown'}`,
          },
        };
      }

      // Exponential backoff
      await new Promise((resolve) => setTimeout(resolve, backoffMs * Math.pow(2, attempt - 1)));
    }
  }

  return {
    success: false,
    queueState: {
      status: 'QUEUED_FOR_SEQUENCING',
      queuePosition: 1,
      estimatedWaitMs: 5000,
    },
  };
}

export type SequenceIntegrityCode = 'sequence_out_of_order' | 'sequence_unverifiable';

/** Raised when the invoice series is broken, so finalization must not proceed. */
export class SequenceIntegrityError extends Error {
  constructor(
    public readonly code: SequenceIntegrityCode,
    public readonly details: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'SequenceIntegrityError';
  }
}

/**
 * Gate invoice finalization on an intact number series.
 *
 * Fails closed on a detected gap (`sequence_out_of_order`) and on an
 * unverifiable series (`sequence_unverifiable`): in both cases we cannot prove
 * the ledger is unbroken, so appending another number would compound the
 * damage rather than preserve órofin númeraröð.
 *
 * Deliberately scoped to *series* integrity, not *claim* failure. A lock or
 * race on the sequence row is transient contention, surfaces as a failed claim,
 * and is handled by the queue-and-retry path — a paying customer must not be
 * told their purchase failed over a recoverable database race.
 */
export function assertSequenceFinalizable(integrity: { valid: boolean; gaps?: number[]; error?: string }): void {
  if (integrity.valid) return;

  if (integrity.gaps && integrity.gaps.length > 0) {
    throw new SequenceIntegrityError('sequence_out_of_order', { gaps: integrity.gaps });
  }

  throw new SequenceIntegrityError('sequence_unverifiable', {
    error: integrity.error ?? 'sequence integrity could not be established',
  });
}

/**
 * Validate sequence integrity - detect gaps or out-of-order numbers.
 */
export async function validateSequenceIntegrity(
  db: D1Database,
  sequenceType: 'invoice' | 'credit_note',
  year: number,
): Promise<{ valid: boolean; gaps?: number[]; error?: string }> {
  try {
    const tableName = sequenceType === 'invoice' ? 'invoices' : 'credit_notes';
    const numberColumn = sequenceType === 'invoice' ? 'invoice_number' : 'credit_note_number';
    const prefix = sequenceType === 'invoice' ? 'REIK' : 'KREDIT';

    // Get all issued numbers for this year
    const issuedNumbers = await db
      .prepare(
        `
      SELECT ${numberColumn} as number 
      FROM ${tableName} 
      WHERE ${numberColumn} LIKE '${prefix}-${year}-%' 
      ORDER BY ${numberColumn}
    `,
      )
      .all<{ number: string }>();

    if (!issuedNumbers.results || issuedNumbers.results.length === 0) {
      return { valid: true }; // No numbers issued yet
    }

    // Extract sequence numbers and check for gaps
    const sequences: number[] = [];
    const gaps: number[] = [];

    for (const row of issuedNumbers.results) {
      const match = row.number.match(new RegExp(`^${prefix}-${year}-(\\d{5})$`));
      if (match) {
        sequences.push(parseInt(match[1], 10));
      }
    }

    sequences.sort((a, b) => a - b);

    // Detect gaps in the sequence
    for (let i = 0; i < sequences.length - 1; i++) {
      const current = sequences[i];
      const next = sequences[i + 1];

      if (next - current > 1) {
        // Gap detected
        for (let missing = current + 1; missing < next; missing++) {
          gaps.push(missing);
        }
      }
    }

    return {
      valid: gaps.length === 0,
      gaps: gaps.length > 0 ? gaps : undefined,
    };
  } catch (error) {
    return {
      valid: false,
      error: `Sequence validation failed: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
}

/**
 * Queue management for orders waiting for sequence resolution.
 */
export class SequenceQueue {
  private static queues = new Map<string, QueuedOrder[]>();

  static addToQueue(sequenceType: 'invoice' | 'credit_note', year: number, order: QueuedOrder): number {
    const key = `${sequenceType}-${year}`;
    const queue = this.queues.get(key) || [];

    // Insert with priority ordering
    if (order.priority === 'high') {
      queue.unshift(order);
    } else {
      queue.push(order);
    }

    this.queues.set(key, queue);
    return queue.length;
  }

  static getQueuePosition(sequenceType: 'invoice' | 'credit_note', year: number, orderId: string): number | null {
    const key = `${sequenceType}-${year}`;
    const queue = this.queues.get(key) || [];

    const position = queue.findIndex((item) => item.orderId === orderId);
    return position >= 0 ? position + 1 : null;
  }

  static processNext(sequenceType: 'invoice' | 'credit_note', year: number): QueuedOrder | null {
    const key = `${sequenceType}-${year}`;
    const queue = this.queues.get(key) || [];

    const next = queue.shift();
    if (queue.length === 0) {
      this.queues.delete(key);
    } else {
      this.queues.set(key, queue);
    }

    return next || null;
  }
}

/**
 * Emit temporary customer confirmation without final invoice number.
 */
export interface TemporaryConfirmation {
  type: 'pöntunarstaðfesting';
  orderId: string;
  orderNumber: string;
  amount: number;
  currency: string;
  status: 'QUEUED_FOR_SEQUENCING';
  message: string;
  estimatedResolutionTime: string;
}

export function createTemporaryConfirmation(params: {
  orderId: string;
  orderNumber: string;
  amount: number;
  currency: string;
  queuePosition: number;
  estimatedWaitMs: number;
}): TemporaryConfirmation {
  const resolutionTime = new Date(Date.now() + params.estimatedWaitMs).toISOString();

  return {
    type: 'pöntunarstaðfesting',
    orderId: params.orderId,
    orderNumber: params.orderNumber,
    amount: params.amount,
    currency: params.currency,
    status: 'QUEUED_FOR_SEQUENCING',
    message: `Pöntun móttekin og er í biðröð fyrir númeraúthlutun. Staða í röð: ${params.queuePosition}`,
    estimatedResolutionTime: resolutionTime,
  };
}

/**
 * Enhanced sequence claiming with incident reporting for audit compliance.
 * 
 * Integrates with the incident reporting system to provide structured
 * observability for Skatturinn compliance audits when sequence conflicts occur.
 */
export async function claimSequenceWithIncidentReporting(
  db: D1Database,
  params: {
    sequenceType: 'invoice' | 'credit_note';
    year: number;
    context: {
      orderId: string;
      customerEmail?: string;
      orderAmount: number;
      currency: string;
    };
    maxRetries?: number;
  }
): Promise<{
  success: boolean;
  sequenceNumber?: number;
  incident?: any; // Will be IncidentReport when imported
}> {
  const { sequenceType, year, context, maxRetries = 3 } = params;
  const tableName = sequenceType === 'invoice' ? 'invoice_sequence' : 'credit_note_sequence';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Ensure year row exists
      await db
        .prepare(`INSERT OR IGNORE INTO ${tableName} (year, next_number) VALUES (?, 1)`)
        .bind(year)
        .run();

      // Atomic sequence claim
      const claimed = await db
        .prepare(
          `UPDATE ${tableName} 
           SET next_number = next_number + 1 
           WHERE year = ? 
           RETURNING next_number - 1 AS sequence`
        )
        .bind(year)
        .first<{ sequence: number }>();

      if (claimed && Number.isInteger(claimed.sequence) && claimed.sequence >= 1) {
        return { success: true, sequenceNumber: claimed.sequence };
      }
    } catch (error) {
      console.error(`Sequence claim attempt ${attempt}/${maxRetries} failed:`, error);
      
      if (attempt === maxRetries) {
        // Import incident functions dynamically to avoid circular dependencies
        const { createSequenceRaceIncident, storeIncidentIdempotent } = await import('./incident-reporter');
        
        // Create incident report for final failure
        const incident = createSequenceRaceIncident({
          orderId: context.orderId,
          attemptedNumber: 0, // Unknown due to failure
          queuePosition: 1,
          concurrentRequests: maxRetries,
          customerEmail: context.customerEmail,
          orderAmount: context.orderAmount,
          currency: context.currency,
        });

        await storeIncidentIdempotent(db, incident);
        return { success: false, incident };
      }

      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)));
    }
  }

  // Fallback (shouldn't reach here but ensures type safety)
  return { success: false };
}
