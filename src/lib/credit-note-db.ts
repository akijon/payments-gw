/**
 * D1 credit note query helpers — sequential numbering, creation, retrieval.
 *
 * Credit notes use a separate sequence (KREDIT-YYYY-NNNNN) from invoices
 * (REIK-YYYY-NNNNN) so that issuing a credit note does not create a gap in
 * the invoice sequence.
 *
 * Audit hash: SHA-256 of the exact payload_json stored at issue time.
 * Retention: issue_date + 7 years (Icelandic accounting law requirement).
 */

import type { CreditNoteRecord } from '../types/invoice';
import { computeAuditHash, computeRetentionDate, RETENTION_YEARS } from './invoice-db';

export { computeAuditHash, computeRetentionDate, RETENTION_YEARS };

/**
 * Atomically claim the next credit note number for the given year.
 * Uses the same transactional upsert pattern as nextInvoiceNumber.
 */
export async function nextCreditNoteNumber(db: D1Database, year: number): Promise<number> {
  // Ensure the row exists
  await db
    .prepare('INSERT OR IGNORE INTO credit_note_sequence (year, next_number) VALUES (?, 1)')
    .bind(year)
    .run();

  // Atomically read-and-increment using UPDATE ... RETURNING
  const row = await db
    .prepare(
      'UPDATE credit_note_sequence SET next_number = next_number + 1 WHERE year = ? RETURNING next_number - 1 AS claimed',
    )
    .bind(year)
    .first<{ claimed: number }>();

  if (!row || !Number.isInteger(row.claimed) || row.claimed < 1) {
    throw new Error('Failed to claim credit note sequence number');
  }
  return row.claimed;
}

interface CreditNoteRow {
  id: string;
  order_id: string;
  credit_note_number: string;
  original_invoice_number: string;
  issue_date: string;
  buyer_kennitala: string | null;
  status: string;
  payload_json: string | null;
  audit_hash: string | null;
  retention_until: string | null;
  created_at: string;
}

function rowToRecord(row: CreditNoteRow): CreditNoteRecord {
  return {
    id: row.id,
    order_id: row.order_id,
    credit_note_number: row.credit_note_number,
    original_invoice_number: row.original_invoice_number,
    issue_date: row.issue_date,
    buyer_kennitala: row.buyer_kennitala,
    status: row.status as CreditNoteRecord['status'],
    payload_json: row.payload_json,
    audit_hash: row.audit_hash,
    retention_until: row.retention_until,
    created_at: row.created_at,
  };
}

export async function createCreditNoteRecord(
  db: D1Database,
  params: {
    id: string;
    orderId: string;
    creditNoteNumber: string;
    originalInvoiceNumber: string;
    issueDate: string;
    buyerKennitala: string | null;
    payloadJson: string;
    auditHash: string;
    retentionUntil: string;
  },
): Promise<{ inserted: boolean }> {
  // INSERT OR IGNORE: if a record already exists for this order_id (concurrent
  // requests), the insert is silently skipped and the caller must re-read.
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO credit_notes (id, order_id, credit_note_number, original_invoice_number, issue_date, buyer_kennitala, status, payload_json, audit_hash, retention_until)
     VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.orderId,
      params.creditNoteNumber,
      params.originalInvoiceNumber,
      params.issueDate,
      params.buyerKennitala,
      params.payloadJson,
      params.auditHash,
      params.retentionUntil,
    )
    .run();
  return { inserted: (result.meta.changes ?? 0) === 1 };
}

export async function getCreditNoteByOrderId(
  db: D1Database,
  orderId: string,
): Promise<CreditNoteRecord | null> {
  const row = await db
    .prepare('SELECT * FROM credit_notes WHERE order_id = ?')
    .bind(orderId)
    .first<CreditNoteRow>();
  return row ? rowToRecord(row) : null;
}

export async function getCreditNoteByNumber(
  db: D1Database,
  creditNoteNumber: string,
): Promise<CreditNoteRecord | null> {
  const row = await db
    .prepare('SELECT * FROM credit_notes WHERE credit_note_number = ?')
    .bind(creditNoteNumber)
    .first<CreditNoteRow>();
  return row ? rowToRecord(row) : null;
}
