/**
 * Standardized incident reporting for payment processing failures.
 * 
 * Provides structured observability for Skatturinn compliance audits,
 * idempotent incident tracking, and standardized recovery responses.
 */

// Import will be used when logging incidents to payment_events table

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL_BLOCKED';

export type FailureType = 
  | 'INVOICE_SEQUENCE_RACE_CONDITION'
  | 'VERIFONE_API_TIMEOUT'
  | 'LANDSBANKINN_API_TIMEOUT'
  | 'VAT_COMPUTATION_TIMEOUT'
  | 'DLQ_OVERFLOW'
  | 'AUDIT_HASH_CORRUPTION';

export interface IncidentReport {
  incident_id: string;
  source_event: string;
  order_id: string;
  failure_type: FailureType;
  severity: IncidentSeverity;
  action_taken: {
    settlement_status?: 'FUNDS_HELD' | 'FUNDS_RELEASED' | 'PENDING_MANUAL_REVIEW';
    invoice_status?: 'QUEUED_FOR_SEQUENCING' | 'ISSUED' | 'DEFERRED' | 'FAILED';
    fallback_applied: string;
    dlq_enqueued: boolean;
    retry_scheduled_at_utc?: string;
  };
  audit_trail: {
    reason_code: string;
    detail: string;
    customer_notified: boolean;
    customer_message_is?: string;
    sequence_details?: {
      attempted_number?: number;
      queue_position?: number;
      concurrent_requests?: number;
    };
  };
  created_at_utc: string;
  resolved_at_utc?: string;
}

export interface SequenceFailureContext {
  orderId: string;
  attemptedNumber: number;
  queuePosition: number;
  concurrentRequests?: number;
  customerEmail?: string;
  orderAmount: number;
  currency: string;
}

/**
 * Generate a structured incident ID with timestamp and sequence number.
 */
export function generateIncidentId(_failureType: FailureType): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const sequence = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `INC-${date}-${sequence}`;
}

/**
 * Create standardized incident report for invoice sequence race conditions.
 */
export function createSequenceRaceIncident(
  context: SequenceFailureContext
): IncidentReport {
  const incidentId = generateIncidentId('INVOICE_SEQUENCE_RACE_CONDITION');
  const retryTime = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  
  return {
    incident_id: incidentId,
    source_event: 'ORDER_PAYMENT_SETTLED',
    order_id: context.orderId,
    failure_type: 'INVOICE_SEQUENCE_RACE_CONDITION',
    severity: 'CRITICAL_BLOCKED',
    action_taken: {
      settlement_status: 'FUNDS_HELD',
      invoice_status: 'QUEUED_FOR_SEQUENCING',
      fallback_applied: 'ISSUED_ORDER_CONFIRMATION_ONLY',
      dlq_enqueued: true,
      retry_scheduled_at_utc: retryTime.toISOString(),
    },
    audit_trail: {
      reason_code: 'SKATTURINN_COMPLIANCE_LOCK_ACT_145_1994',
      detail: `Sequential invoice number generation encountered a concurrent write lock. Deferred emission to avoid gap in numbering series.`,
      customer_notified: true,
      customer_message_is: 'Greiðsla hefur borist. Pöntun þín er móttekin og löglegur sölureikningur verður sendur í tölvupósti innan skamms.',
      sequence_details: {
        attempted_number: context.attemptedNumber,
        queue_position: context.queuePosition,
        concurrent_requests: context.concurrentRequests,
      },
    },
    created_at_utc: new Date().toISOString(),
  };
}

/**
 * Idempotent incident storage - prevents duplicate incident reports.
 */
export async function storeIncidentIdempotent(
  db: D1Database,
  incident: IncidentReport
): Promise<{ stored: boolean; existingId?: string }> {
  // Check for existing incident on same order + failure type
  const existing = await db
    .prepare(
      `SELECT incident_id FROM incidents 
       WHERE order_id = ? AND failure_type = ? AND resolved_at_utc IS NULL`
    )
    .bind(incident.order_id, incident.failure_type)
    .first<{ incident_id: string }>();

  if (existing) {
    return { stored: false, existingId: existing.incident_id };
  }

  // INSERT OR IGNORE for race condition safety
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO incidents 
       (incident_id, source_event, order_id, failure_type, severity, 
        action_taken_json, audit_trail_json, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      incident.incident_id,
      incident.source_event,
      incident.order_id,
      incident.failure_type,
      incident.severity,
      JSON.stringify(incident.action_taken),
      JSON.stringify(incident.audit_trail),
      incident.created_at_utc
    )
    .run();

  return { stored: (result.meta.changes ?? 0) === 1 };
}

/**
 * Resolve an incident when the underlying issue is fixed.
 */
export async function resolveIncident(
  db: D1Database,
  incidentId: string,
  resolution: {
    resolved_by: 'auto_retry' | 'manual_intervention' | 'system_recovery';
    resolution_detail: string;
    invoice_number?: string;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE incidents 
       SET resolved_at_utc = datetime('now'), 
           resolution_json = ?
       WHERE incident_id = ? AND resolved_at_utc IS NULL`
    )
    .bind(JSON.stringify(resolution), incidentId)
    .run();

  return (result.meta.changes ?? 0) === 1;
}

/**
 * Get active incidents for monitoring/alerting.
 */
export async function getActiveIncidents(
  db: D1Database,
  filters?: {
    severity?: IncidentSeverity;
    failure_type?: FailureType;
    order_id?: string;
  }
): Promise<IncidentReport[]> {
  let query = 'SELECT * FROM incidents WHERE resolved_at_utc IS NULL';
  const binds: string[] = [];

  if (filters?.severity) {
    query += ' AND severity = ?';
    binds.push(filters.severity);
  }

  if (filters?.failure_type) {
    query += ' AND failure_type = ?';
    binds.push(filters.failure_type);
  }

  if (filters?.order_id) {
    query += ' AND order_id = ?';
    binds.push(filters.order_id);
  }

  query += ' ORDER BY created_at_utc DESC';

  const result = await db.prepare(query).bind(...binds).all<{
    incident_id: string;
    source_event: string;
    order_id: string;
    failure_type: FailureType;
    severity: IncidentSeverity;
    action_taken_json: string;
    audit_trail_json: string;
    created_at_utc: string;
    resolved_at_utc: string | null;
    resolution_json: string | null;
  }>();

  return result.results.map(row => ({
    incident_id: row.incident_id,
    source_event: row.source_event,
    order_id: row.order_id,
    failure_type: row.failure_type,
    severity: row.severity,
    action_taken: JSON.parse(row.action_taken_json),
    audit_trail: JSON.parse(row.audit_trail_json),
    created_at_utc: row.created_at_utc,
    resolved_at_utc: row.resolved_at_utc || undefined,
  }));
}

/**
 * Enhanced sequence management with incident reporting.
 */
export async function claimSequenceWithIncidentReporting(
  db: D1Database,
  params: {
    sequenceType: 'invoice' | 'credit_note';
    year: number;
    context: SequenceFailureContext;
    maxRetries?: number;
  }
): Promise<{
  success: boolean;
  sequenceNumber?: number;
  incident?: IncidentReport;
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
        // Create incident report for final failure
        const incident = createSequenceRaceIncident({
          ...context,
          attemptedNumber: 0, // Unknown due to failure
          queuePosition: 1,
          concurrentRequests: maxRetries,
        });

        await storeIncidentIdempotent(db, incident);

        return { success: false, incident };
      }

      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt - 1)));
    }
  }

  // Fallback (shouldn't reach here)
  const incident = createSequenceRaceIncident({
    ...context,
    attemptedNumber: 0,
    queuePosition: 1,
    concurrentRequests: maxRetries,
  });

  return { success: false, incident };
}