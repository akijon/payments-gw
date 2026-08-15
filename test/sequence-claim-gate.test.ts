/**
 * Sequence integrity gating on the claim path.
 *
 * The integrity scan reads every invoice issued in the year, so running it on
 * each finalization would add an O(n) D1 read per invoice. It is therefore
 * gated behind the *claim*: verified once when a year's sequence is first
 * touched in this isolate, then skipped for subsequent claims.
 *
 * A detected gap rejects the claim outright (órofin númeraröð is broken and no
 * retry can repair it). Transient contention is not corruption and never
 * reaches this gate — it surfaces as a failed claim on the retry path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  claimVerifiedInvoiceNumber,
  resetSequenceVerificationCache,
} from '../src/lib/invoice-db';
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

describe('Sequence integrity gating on the claim path', () => {
  beforeEach(async () => {
    resetSequenceVerificationCache();
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
    await seedInvoice(`REIK-${YEAR}-00001`, 'gate-a');
    await seedInvoice(`REIK-${YEAR}-00004`, 'gate-b');

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).rejects.toMatchObject({
      code: 'sequence_out_of_order',
      details: { gaps: [2, 3] },
    });
  });

  it('verifies once per year, not once per claim', async () => {
    // Second claim must not re-scan: that is the O(n)-per-invoice cost the
    // cache exists to avoid. Seeding a gap AFTER the first claim proves the
    // scan did not run again.
    await claimVerifiedInvoiceNumber(env.DB, YEAR);
    await seedInvoice(`REIK-${YEAR}-00007`, 'gate-c');
    await seedInvoice(`REIK-${YEAR}-00009`, 'gate-d');

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).resolves.toBeTypeOf('number');
  });

  it('re-verifies after the cache is reset', async () => {
    await claimVerifiedInvoiceNumber(env.DB, YEAR);
    await seedInvoice(`REIK-${YEAR}-00007`, 'gate-c');
    await seedInvoice(`REIK-${YEAR}-00009`, 'gate-d');

    resetSequenceVerificationCache();

    await expect(claimVerifiedInvoiceNumber(env.DB, YEAR)).rejects.toThrow(SequenceIntegrityError);
  });
});
