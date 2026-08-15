/**
 * Enhanced invoice generation with integrated incident reporting.
 * 
 * This module demonstrates how to integrate the incident reporting system
 * with existing invoice generation to provide structured observability
 * for Skatturinn compliance audits when sequence conflicts occur.
 */

import { claimSequenceWithIncidentReporting } from './sequence-management';
import { resolveIncident, getActiveIncidents } from './incident-reporter';
import { createInvoiceRecord, computeAuditHash, computeRetentionDate } from './invoice-db';
import { generateUUID } from './db';
import type { IncidentReport } from './incident-reporter';

export interface EnhancedInvoiceResult {
  success: boolean;
  invoice?: {
    id: string;
    invoice_number: string;
    order_id: string;
  };
  incident?: IncidentReport;
  customer_message?: {
    type: 'success' | 'queued_for_sequencing';
    message_is: string;
    estimated_resolution?: string;
  };
}

/**
 * Generate invoice with enhanced incident reporting and customer communication.
 * 
 * This function integrates sequence management with incident reporting to provide:
 * - Structured failure tracking for audit compliance
 * - Idempotent incident storage 
 * - Customer-facing messages in Icelandic
 * - Automatic incident resolution on retry success
 */
export async function generateInvoiceWithIncidentReporting(
  db: D1Database,
  params: {
    orderId: string;
    orderData: {
      order_number: string;
      amount: number;
      currency: string;
      customer_email?: string;
      buyer_kennitala?: string;
    };
    invoicePayload: string; // Pre-computed invoice JSON
  }
): Promise<EnhancedInvoiceResult> {
  const { orderId, orderData, invoicePayload } = params;
  const currentYear = new Date().getFullYear();

  try {
    // Enhanced sequence claiming with incident reporting
    const sequenceResult = await claimSequenceWithIncidentReporting(db, {
      sequenceType: 'invoice',
      year: currentYear,
      context: {
        orderId,
        customerEmail: orderData.customer_email,
        orderAmount: orderData.amount,
        currency: orderData.currency,
      },
    });

    if (sequenceResult.success && sequenceResult.sequenceNumber) {
      // Success path: create invoice and resolve any existing incidents
      const invoiceNumber = `REIK-${currentYear}-${sequenceResult.sequenceNumber.toString().padStart(5, '0')}`;
      const invoiceId = generateUUID();

      const invoiceResult = await createInvoiceRecord(db, {
        id: invoiceId,
        orderId,
        invoiceNumber,
        issueDate: new Date().toISOString().split('T')[0],
        dueDate: null, // Immediate payment
        deliveryDate: null,
        buyerKennitala: orderData.buyer_kennitala || null,
        payloadJson: invoicePayload,
        auditHash: await computeAuditHash(invoicePayload),
        retentionUntil: computeRetentionDate(new Date().toISOString().split('T')[0]),
      });

      if (!invoiceResult.inserted) {
        // Invoice already exists for this order (concurrent request)
        throw new Error('Invoice already exists for this order');
      }

      // Resolve any existing incidents for this order
      const existingIncidents = await getActiveIncidents(db, {
        order_id: orderId,
        failure_type: 'INVOICE_SEQUENCE_RACE_CONDITION',
      });

      for (const incident of existingIncidents) {
        await resolveIncident(db, incident.incident_id, {
          resolved_by: 'auto_retry',
          resolution_detail: 'Sequence number successfully claimed on retry',
          invoice_number: invoiceNumber,
        });
      }

      return {
        success: true,
        invoice: {
          id: invoiceId,
          invoice_number: invoiceNumber,
          order_id: orderId,
        },
        customer_message: {
          type: 'success',
          message_is: 'Greiðsla móttekin og sölureikningur hefur verið sendur í tölvupóst.',
        },
      };
    }

    // Failure path: sequence conflict occurred, incident was created
    if (sequenceResult.incident) {
      const retryTime = sequenceResult.incident.action_taken.retry_scheduled_at_utc;
      const retryDate = retryTime ? new Date(retryTime) : new Date(Date.now() + 5 * 60 * 1000);

      return {
        success: false,
        incident: sequenceResult.incident,
        customer_message: {
          type: 'queued_for_sequencing',
          message_is: 'Greiðsla hefur borist. Pöntun þín er móttekin og löglegur sölureikningur verður sendur í tölvupósti innan skamms.',
          estimated_resolution: retryDate.toLocaleTimeString('is-IS', {
            timeZone: 'Atlantic/Reykjavik',
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
      };
    }

    // Fallback error case
    throw new Error('Unexpected sequence claiming result');

  } catch (error) {
    // Unexpected error - create incident for investigation
    const { createSequenceRaceIncident, storeIncidentIdempotent } = await import('./incident-reporter');
    
    const incident = createSequenceRaceIncident({
      orderId,
      attemptedNumber: 0,
      queuePosition: 1,
      customerEmail: orderData.customer_email,
      orderAmount: orderData.amount,
      currency: orderData.currency,
    });

    // Override incident details for unexpected error
    incident.failure_type = 'VAT_COMPUTATION_TIMEOUT'; // More generic failure type
    incident.audit_trail.detail = `Unexpected error during invoice generation: ${error instanceof Error ? error.message : 'unknown'}`;
    incident.audit_trail.reason_code = 'UNEXPECTED_INVOICE_GENERATION_ERROR';

    await storeIncidentIdempotent(db, incident);

    return {
      success: false,
      incident,
      customer_message: {
        type: 'queued_for_sequencing',
        message_is: 'Tæknileg villa kom upp. Pöntun þín er móttekin og verður afgreidd í næstu lotunni.',
        estimated_resolution: new Date(Date.now() + 15 * 60 * 1000).toLocaleTimeString('is-IS', {
          timeZone: 'Atlantic/Reykjavik',
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
    };
  }
}

/**
 * Example usage in a route handler:
 * 
 * ```typescript
 * // In src/routes/invoice.ts
 * const result = await generateInvoiceWithIncidentReporting(env.DB, {
 *   orderId: order.id,
 *   orderData: {
 *     order_number: order.order_number,
 *     amount: order.amount,
 *     currency: order.currency,
 *     customer_email: order.customer_email,
 *     buyer_kennitala: order.buyer_kennitala,
 *   },
 *   invoicePayload: JSON.stringify(computedInvoice),
 * });
 * 
 * if (result.success && result.invoice) {
 *   return c.json({
 *     invoice_id: result.invoice.id,
 *     invoice_number: result.invoice.invoice_number,
 *     status: 'issued',
 *     message: result.customer_message?.message_is,
 *   });
 * } else if (result.incident) {
 *   return c.json({
 *     status: 'queued_for_sequencing',
 *     incident_id: result.incident.incident_id,
 *     message: result.customer_message?.message_is,
 *     estimated_resolution: result.customer_message?.estimated_resolution,
 *   }, 202); // HTTP 202 Accepted
 * }
 * ```
 */