/**
 * D1 invoice query helpers — sequential numbering, creation, retrieval.
 */

import type { InvoiceRecord } from '../types/invoice';

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
  },
): Promise<{ inserted: boolean }> {
  // INSERT OR IGNORE: if a record already exists for this order_id (concurrent
  // requests), the insert is silently skipped and the caller must re-read.
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO invoices (id, order_id, invoice_number, issue_date, due_date, delivery_date, buyer_kennitala, status, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
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
