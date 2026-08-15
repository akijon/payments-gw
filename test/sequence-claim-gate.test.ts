/**
 * Sequence integrity gating on the claim path.
 *
 * Validation runs on EVERY claim — not cached — because a cache would let a
 * gap introduced after the first claim for a year slip past permanently. The
 * validator compares issued invoice numbers against the sequence cursor
 * (`invoice_sequence.next_number`), not just against each other, so it can
 * detect a gap at the tail of the range (a claim whose invoice write never
 * landed), not only gaps between two persisted rows.
 *
 * A detected gap rejects the claim outright (órofin númeraröð is broken and no
 * retry can repair it) — except the single most recent claim, whose invoice
 * write is legitimately still in flight within the same request. Transient
 * contention is not corruption and never reaches this gate — it surfaces as a
 * failed claim on the retry path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { claimVerifiedInvoiceNumber } from '../src/lib/invoice-db';
import { SequenceIntegrityError } from '../src/lib/sequence-management';

const YEAR = 2031;

async function seedInvoice(invoiceNumber: string, orderSuffix: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO orders (id, order_number, status, currency, amount, items_json)
     VALUES (?, ?, 'paid', 'ISK', 10000, '[]')`,
  )
    .bind(`order-${orderSuffix}`, `IRJA-${orderSuffix}`)
    .run();

  await env.DB.prepare(
    `INSERT INTO invoices (id, order_id, invoice_number, issue_date)
     VALUES (?, ?, ?, '2031-01-01')`,
  )
    .bind(`inv-${orderSuffix}`, `order-${orderSuffix}`, invoiceNumber)
    .run();
}

/**
 * Advance the year's cursor to `count` without writing invoice rows —
 * simulates claims whose invoice write never landed, which is the actual
 * shape of ledger corruption the gate exists to catch (as opposed to
 * `seedInvoice`, which writes rows the cursor never claimed).
 */
async function advanceCursor(count: number): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO invoice_sequence (year, next_number) VALUES (?, 1)').bind(YEAR).run();
  await env.DB.prepare('UPDATE invoice_sequence SET next_number = ? WHERE year = ?')
    .bind(count + 1, YEAR)
    .run();
}

describe('Sequence integrity gating on the claim path', () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM invoices WHERE invoice_number LIKE 'REIK-${YEAR}-%'`).run();
    await env.DB.prepare(`DELETE FROM orders WHERE order_number LIKE 'IRJA-gate-%'`).run();
    await env.DB.prepare('DELETE FROM invoice_sequence WHERE year = ?').bind(YEAR).run();
  });

  it('claims a number on an intact series', async () => {
    const claimed = await claimVerifiedInvoiceNumber(env.DB, YEAR);

    expect(claimed).toBe(1);
  });

  it('claims consecutive numbers across repeated claims', async () => {
    const first = await claimVerifiedInvoiceNumber(env.DB, YEAR);
    const second = await claimVerifiedInvoiceNumber(env.DB, YEAR);

    expect(second).toBe(first + 1);
  });

  it('rejects the claim when the issued series has a gap', async () => {
    // REIK-2031-00001 and REIK-2031-00003 issued; 00002 is missing.
    await seedInvoice(`REIK-${YEAR}-00001`, 'gate-a');
    await seedInvoice(`REIK-${YEAR}-00003`, 'gate-b');

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).rejects.toThrow(SequenceIntegrityError);
  });

  it('does not consume a sequence number when integrity fails', async () => {
    await seedInvoice(`REIK-${YEAR}-00001`, 'gate-a');
    await seedInvoice(`REIK-${YEAR}-00003`, 'gate-b');

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).rejects.toThrow(SequenceIntegrityError);

    // The gate must run BEFORE the increment, otherwise a rejected
    // finalization still burns a number and widens the ledger gap.
    const row = await env.DB.prepare('SELECT next_number FROM invoice_sequence WHERE year = ?')
      .bind(YEAR)
      .first<{ next_number: number }>();
    expect(row?.next_number ?? 1).toBe(1);
  });

  it('reports the missing numbers on rejection', async () => {
    // Cursor claimed through 4, but only 1 and 4 were ever persisted — 2 and 3
    // are stuck mid-flight from requests that never completed their write.
    await advanceCursor(4);
    await seedInvoice(`REIK-${YEAR}-00001`, 'gate-a');
    await seedInvoice(`REIK-${YEAR}-00004`, 'gate-b');

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).rejects.toMatchObject({
      code: 'sequence_out_of_order',
      details: { gaps: [2, 3] },
    });
  });

  it('tolerates the single most recent claim not yet having its invoice written', async () => {
    // Claiming a number and persisting its invoice are two separate D1 calls;
    // this is the normal window between them within one in-flight request,
    // not corruption — only an EARLIER gap indicates a write that never
    // completed.
    await advanceCursor(3);
    await seedInvoice(`REIK-${YEAR}-00001`, 'gate-a');
    await seedInvoice(`REIK-${YEAR}-00002`, 'gate-b');
    // 00003 intentionally not written yet.

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).resolves.toBe(4);
  });

  it('re-validates on every claim, not once per year', async () => {
    // A cached pass would let a gap introduced after the first claim slip by
    // silently forever. Every claim must independently prove the series is
    // still intact. Only the single most recent claim is tolerated as
    // in-flight — claiming 1 and then advancing straight to 3 means TWO
    // numbers (1 and 2) are unaccounted for, which is more than one request's
    // legitimate in-flight window and so is reported as corruption.
    await claimVerifiedInvoiceNumber(env.DB, YEAR); // claims 1, writes nothing
    await advanceCursor(3); // simulate 2 and 3 also claimed, neither written

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).rejects.toMatchObject({
      code: 'sequence_out_of_order',
      details: { gaps: [1, 2, 3] },
    });
  });
});
