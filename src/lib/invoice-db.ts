/**
 * D1 invoice query helpers — sequential numbering, creation, retrieval.
 *
 * Audit hash: SHA-256 of the exact payload_json stored at issue time.
 * Retention: issue_date + 7 years (Icelandic accounting law requirement).
 */

import type { InvoiceRecord } from '../types/invoice';

/** 7-year retention period for Icelandic accounting records. */
export const RETENTION_YEARS = 7;

/**
 * Compute SHA-256 hash of a string using the Web Crypto API.
 * Returns hex-encoded hash prefixed with "sha256:" for algorithm identification.
 */
export async function computeAuditHash(payloadJson: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(payloadJson);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hashHex}`;
}

/** Compute retention date: issue_date + RETENTION_YEARS, as YYYY-MM-DD. */
export function computeRetentionDate(issueDate: string): string {
  const [year, month, day] = issueDate.split('-').map(Number);
  if (!year || !month || !day) return issueDate;
  const retentionYear = year + RETENTION_YEARS;
  return `${retentionYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Atomically claim the next invoice number for the given year.
 * Uses a transactional upsert pattern: INSERT OR IGNORE the year row,
 * then UPDATE to increment. Returns the sequence number to use.
 */
export async function nextInvoiceNumber(db: D1Database, year: number): Promise<number> {
  // Ensure the row exists
  await db.prepare('INSERT OR IGNORE INTO invoice_sequence (year, next_number) VALUES (?, 1)').bind(year).run();

  // Atomically read-and-increment using UPDATE ... RETURNING
  const row = await db
    .prepare(
      'UPDATE invoice_sequence SET next_number = next_number + 1 WHERE year = ? RETURNING next_number - 1 AS claimed',
    )
    .bind(year)
    .first<{ claimed: number }>();

  if (!row || !Number.isInteger(row.claimed) || row.claimed < 1) {
    throw new Error('Failed to claim invoice sequence number');
  }
  return row.claimed;
}

/**
 * Years whose invoice series has already been verified intact in this isolate.
 *
 * The integrity scan reads every invoice issued in the year, so running it per
 * finalization would cost an O(n) D1 read per invoice. Verifying once per year
 * on the claim path keeps the guarantee where it matters — no number is issued
 * onto a broken ledger — without paying the scan on every sale.
 */
const verifiedSequenceYears = new Set<number>();

/** Test seam: forces the next claim for a year to re-run the integrity scan. */
export function resetSequenceVerificationCache(): void {
  verifiedSequenceYears.clear();
}

/**
 * Claim the next invoice number, refusing to issue onto a broken series.
 *
 * The integrity check runs BEFORE the increment: a rejected finalization must
 * not consume a number, or the rejection would itself widen the gap it is
 * refusing to append to.
 *
 * Only true out-of-order corruption rejects here. Transient lock/row contention
 * is not corruption — it surfaces as a failed claim and is handled by the
 * queue-and-retry path, so a paying customer is never told their purchase
 * failed over a recoverable database race.
 */
export async function claimVerifiedInvoiceNumber(db: D1Database, year: number): Promise<number> {
  if (!verifiedSequenceYears.has(year)) {
    const { validateSequenceIntegrity, assertSequenceFinalizable } = await import('./sequence-management');
    assertSequenceFinalizable(await validateSequenceIntegrity(db, 'invoice', year));
    verifiedSequenceYears.add(year);
  }

  return nextInvoiceNumber(db, year);
}

/** Get the current next invoice number for a year (without claiming). */
export async function peekInvoiceSequence(db: D1Database, year: number): Promise<number> {
  const row = await db
    .prepare('SELECT next_number FROM invoice_sequence WHERE year = ?')
    .bind(year)
    .first<{ next_number: number }>();
  return row?.next_number ?? 1;
}

interface InvoiceRow {
  id: string;
  order_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  delivery_date: string | null;
  buyer_kennitala: string | null;
  status: string;
  payload_json: string | null;
  audit_hash: string | null;
  retention_until: string | null;
  created_at: string;
}

function rowToRecord(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    order_id: row.order_id,
    invoice_number: row.invoice_number,
    issue_date: row.issue_date,
    due_date: row.due_date,
    delivery_date: row.delivery_date,
    buyer_kennitala: row.buyer_kennitala,
    status: row.status as InvoiceRecord['status'],
    payload_json: row.payload_json,
    audit_hash: row.audit_hash,
    retention_until: row.retention_until,
    created_at: row.created_at,
  };
}

export async function createInvoiceRecord(
  db: D1Database,
  params: {
    id: string;
    orderId: string;
    invoiceNumber: string;
    issueDate: string;
    dueDate: string | null;
    deliveryDate: string | null;
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
      `INSERT OR IGNORE INTO invoices (id, order_id, invoice_number, issue_date, due_date, delivery_date, buyer_kennitala, status, payload_json, audit_hash, retention_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.orderId,
      params.invoiceNumber,
      params.issueDate,
      params.dueDate,
      params.deliveryDate,
      params.buyerKennitala,
      params.payloadJson,
      params.auditHash,
      params.retentionUntil,
    )
    .run();
  return { inserted: (result.meta.changes ?? 0) === 1 };
}

export async function getInvoiceByOrderId(db: D1Database, orderId: string): Promise<InvoiceRecord | null> {
  const row = await db.prepare('SELECT * FROM invoices WHERE order_id = ?').bind(orderId).first<InvoiceRow>();
  return row ? rowToRecord(row) : null;
}

export async function getInvoiceByNumber(db: D1Database, invoiceNumber: string): Promise<InvoiceRecord | null> {
  const row = await db
    .prepare('SELECT * FROM invoices WHERE invoice_number = ?')
    .bind(invoiceNumber)
    .first<InvoiceRow>();
  return row ? rowToRecord(row) : null;
}
