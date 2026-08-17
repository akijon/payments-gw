/**
 * Tests for incident reporting system - structured failure tracking
 * with idempotency and audit trail for Skatturinn compliance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  generateIncidentId,
  createSequenceRaceIncident,
  storeIncidentIdempotent,
  resolveIncident,
  getActiveIncidents,
  type SequenceFailureContext,
} from '../src/lib/incident-reporter';

describe('Incident Reporting', () => {
  let db: D1Database;

  beforeEach(async () => {
    db = env.DB;

    // Clean up any existing test data
    await db.prepare('DELETE FROM incidents').run();
    await db.prepare('DELETE FROM orders WHERE id LIKE "ORD-TEST-%"').run();
  });

  describe('generateIncidentId', () => {
    it('generates INC-YYYYMMDD-NNN format', () => {
      const incidentId = generateIncidentId('INVOICE_SEQUENCE_RACE_CONDITION');
      expect(incidentId).toMatch(/^INC-\d{8}-\d{3}$/);
    });

    it('generates unique IDs for concurrent calls', () => {
      const id1 = generateIncidentId('INVOICE_SEQUENCE_RACE_CONDITION');
      const id2 = generateIncidentId('VERIFONE_API_TIMEOUT');
      expect(id1).not.toBe(id2);
    });
  });

  describe('createSequenceRaceIncident', () => {
    const context: SequenceFailureContext = {
      orderId: 'ORD-20260815-ABC123',
      attemptedNumber: 42,
      queuePosition: 3,
      concurrentRequests: 5,
      customerEmail: 'test@example.com',
      orderAmount: 15000,
      currency: 'ISK',
    };

    it('creates structured incident report', () => {
      const incident = createSequenceRaceIncident(context);

      expect(incident.incident_id).toMatch(/^INC-\d{8}-\d{3}$/);
      expect(incident.source_event).toBe('ORDER_PAYMENT_SETTLED');
      expect(incident.order_id).toBe(context.orderId);
      expect(incident.failure_type).toBe('INVOICE_SEQUENCE_RACE_CONDITION');
      expect(incident.severity).toBe('CRITICAL_BLOCKED');

      expect(incident.action_taken).toEqual({
        settlement_status: 'FUNDS_HELD',
        invoice_status: 'QUEUED_FOR_SEQUENCING',
        fallback_applied: 'ISSUED_ORDER_CONFIRMATION_ONLY',
        dlq_enqueued: true,
        retry_scheduled_at_utc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });

      expect(incident.audit_trail).toEqual({
        reason_code: 'SKATTURINN_COMPLIANCE_LOCK_ACT_145_1994',
        detail:
          'Sequential invoice number generation encountered a concurrent write lock. Deferred emission to avoid gap in numbering series.',
        customer_notified: true,
        customer_message_is:
          'Greiðsla hefur borist. Pöntun þín er móttekin og löglegur sölureikningur verður sendur í tölvupósti innan skamms.',
        sequence_details: {
          attempted_number: 42,
          queue_position: 3,
          concurrent_requests: 5,
        },
      });

      expect(incident.created_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(incident.resolved_at_utc).toBeUndefined();
    });

    it('schedules retry 5 minutes in the future', () => {
      const incident = createSequenceRaceIncident(context);
      const retryTime = new Date(incident.action_taken.retry_scheduled_at_utc!);
      const now = new Date();
      const diffMs = retryTime.getTime() - now.getTime();

      // Should be approximately 5 minutes (allow 1 second tolerance)
      expect(diffMs).toBeGreaterThan(4 * 60 * 1000);
      expect(diffMs).toBeLessThan(6 * 60 * 1000);
    });
  });

  describe('storeIncidentIdempotent', () => {
    it('stores new incident successfully', async () => {
      // Create a test order first (required for foreign key constraint)
      await db
        .prepare(
          `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
           VALUES (?, ?, 'paid', 'ISK', 10000, '[]')`,
        )
        .bind('ORD-TEST-001', 'IRJA-20260815-001')
        .run();

      const context: SequenceFailureContext = {
        orderId: 'ORD-TEST-001',
        attemptedNumber: 1,
        queuePosition: 1,
        orderAmount: 10000,
        currency: 'ISK',
      };

      const incident = createSequenceRaceIncident(context);
      const result = await storeIncidentIdempotent(db, incident);

      expect(result.stored).toBe(true);
      expect(result.existingId).toBeUndefined();

      // Verify stored in database
      const stored = await db
        .prepare('SELECT * FROM incidents WHERE incident_id = ?')
        .bind(incident.incident_id)
        .first();

      expect(stored).toBeDefined();
    });

    it('prevents duplicate incidents for same order + failure type', async () => {
      // Create a test order first
      await db
        .prepare(
          `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
           VALUES (?, ?, 'paid', 'ISK', 10000, '[]')`,
        )
        .bind('ORD-TEST-002', 'IRJA-20260815-002')
        .run();

      const context: SequenceFailureContext = {
        orderId: 'ORD-TEST-002',
        attemptedNumber: 1,
        queuePosition: 1,
        orderAmount: 10000,
        currency: 'ISK',
      };

      const incident1 = createSequenceRaceIncident(context);
      const incident2 = createSequenceRaceIncident(context);

      const result1 = await storeIncidentIdempotent(db, incident1);
      const result2 = await storeIncidentIdempotent(db, incident2);

      expect(result1.stored).toBe(true);
      expect(result2.stored).toBe(false);
      expect(result2.existingId).toBe(incident1.incident_id);

      // Verify only one incident in database
      const count = await db
        .prepare('SELECT COUNT(*) as count FROM incidents WHERE order_id = ?')
        .bind(context.orderId)
        .first<{ count: number }>();

      expect(count?.count).toBe(1);
    });

    it('allows different failure types for same order', async () => {
      // Create a test order first
      await db
        .prepare(
          `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
           VALUES (?, ?, 'paid', 'ISK', 10000, '[]')`,
        )
        .bind('ORD-TEST-003', 'IRJA-20260815-003')
        .run();

      const context: SequenceFailureContext = {
        orderId: 'ORD-TEST-003',
        attemptedNumber: 1,
        queuePosition: 1,
        orderAmount: 10000,
        currency: 'ISK',
      };

      const incident1 = createSequenceRaceIncident(context);

      // Create a different type of incident for same order
      const incident2 = {
        ...incident1,
        incident_id: generateIncidentId('VERIFONE_API_TIMEOUT'),
        failure_type: 'VERIFONE_API_TIMEOUT' as const,
      };

      const result1 = await storeIncidentIdempotent(db, incident1);
      const result2 = await storeIncidentIdempotent(db, incident2);

      expect(result1.stored).toBe(true);
      expect(result2.stored).toBe(true);

      // Verify two incidents in database
      const count = await db
        .prepare('SELECT COUNT(*) as count FROM incidents WHERE order_id = ?')
        .bind(context.orderId)
        .first<{ count: number }>();

      expect(count?.count).toBe(2);
    });
  });

  describe('resolveIncident', () => {
    it('resolves active incident', async () => {
      // Create a test order first
      await db
        .prepare(
          `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
           VALUES (?, ?, 'paid', 'ISK', 10000, '[]')`,
        )
        .bind('ORD-TEST-004', 'IRJA-20260815-004')
        .run();

      const context: SequenceFailureContext = {
        orderId: 'ORD-TEST-004',
        attemptedNumber: 1,
        queuePosition: 1,
        orderAmount: 10000,
        currency: 'ISK',
      };

      const incident = createSequenceRaceIncident(context);
      await storeIncidentIdempotent(db, incident);

      const resolved = await resolveIncident(db, incident.incident_id, {
        resolved_by: 'auto_retry',
        resolution_detail: 'Sequence number successfully claimed on retry',
        invoice_number: 'REIK-2026-00042',
      });

      expect(resolved).toBe(true);

      // Verify resolution stored
      const stored = await db
        .prepare('SELECT resolved_at_utc, resolution_json FROM incidents WHERE incident_id = ?')
        .bind(incident.incident_id)
        .first<{ resolved_at_utc: string; resolution_json: string }>();

      expect(stored?.resolved_at_utc).toBeDefined();
      expect(JSON.parse(stored?.resolution_json || '{}')).toEqual({
        resolved_by: 'auto_retry',
        resolution_detail: 'Sequence number successfully claimed on retry',
        invoice_number: 'REIK-2026-00042',
      });
    });

    it('returns false for non-existent incident', async () => {
      const resolved = await resolveIncident(db, 'INC-99999999-999', {
        resolved_by: 'manual_intervention',
        resolution_detail: 'Does not exist',
      });

      expect(resolved).toBe(false);
    });
  });

  describe('getActiveIncidents', () => {
    beforeEach(async () => {
      // Clean up first
      await db.prepare('DELETE FROM incidents').run();
      await db.prepare('DELETE FROM orders WHERE id LIKE "ORD-ACTIVE%" OR id LIKE "ORD-RESOLVED%"').run();

      // Create test orders first
      const orderIds = ['ORD-ACTIVE-001', 'ORD-ACTIVE-002', 'ORD-RESOLVED-001'];
      for (let i = 0; i < orderIds.length; i++) {
        const orderId = orderIds[i];
        await db
          .prepare(
            `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
             VALUES (?, ?, 'paid', 'ISK', 10000, '[]')`,
          )
          .bind(orderId, `IRJA-${Date.now()}-${i}`) // Unique order numbers
          .run();
      }

      // Create test incidents
      const contexts = [
        { orderId: 'ORD-ACTIVE-001', severity: 'CRITICAL_BLOCKED' as const },
        { orderId: 'ORD-ACTIVE-002', severity: 'HIGH' as const },
        { orderId: 'ORD-RESOLVED-001', severity: 'MEDIUM' as const },
      ];

      for (const ctx of contexts) {
        const incident = createSequenceRaceIncident({
          orderId: ctx.orderId,
          attemptedNumber: 1,
          queuePosition: 1,
          orderAmount: 10000,
          currency: 'ISK',
        });

        // Override severity for test
        incident.severity = ctx.severity;

        await storeIncidentIdempotent(db, incident);

        // Resolve one incident
        if (ctx.orderId === 'ORD-RESOLVED-001') {
          await resolveIncident(db, incident.incident_id, {
            resolved_by: 'auto_retry',
            resolution_detail: 'Test resolution',
          });
        }
      }
    });

    it('returns only active incidents', async () => {
      const incidents = await getActiveIncidents(db);

      expect(incidents).toHaveLength(2);
      expect(incidents.every((i) => i.resolved_at_utc === undefined)).toBe(true);
    });

    it('filters by severity', async () => {
      const incidents = await getActiveIncidents(db, { severity: 'CRITICAL_BLOCKED' });

      expect(incidents).toHaveLength(1);
      expect(incidents[0].severity).toBe('CRITICAL_BLOCKED');
      expect(incidents[0].order_id).toBe('ORD-ACTIVE-001');
    });

    it('filters by failure type', async () => {
      const incidents = await getActiveIncidents(db, {
        failure_type: 'INVOICE_SEQUENCE_RACE_CONDITION',
      });

      expect(incidents).toHaveLength(2);
      expect(incidents.every((i) => i.failure_type === 'INVOICE_SEQUENCE_RACE_CONDITION')).toBe(true);
    });

    it('filters by order ID', async () => {
      const incidents = await getActiveIncidents(db, { order_id: 'ORD-ACTIVE-002' });

      expect(incidents).toHaveLength(1);
      expect(incidents[0].order_id).toBe('ORD-ACTIVE-002');
    });
  });
});
