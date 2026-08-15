/**
 * Sequence integrity gate for invoice finalization.
 *
 * Icelandic accounting law requires an unbroken invoice number series
 * (órofin númeraröð) — Act No. 145/1994, Reg. No. 505/2013.
 *
 * Two failure modes are deliberately treated differently:
 *
 *   - Transient contention (lock/race on the sequence row) is NOT corruption.
 *     The order stays queued and is retried, so a paying customer is never
 *     told their purchase failed over a recoverable database race.
 *
 *   - True out-of-order corruption (a gap in the issued series) is
 *     unrecoverable by retrying and must reject finalization immediately,
 *     so a second number is never written on top of a broken ledger.
 */
import { describe, it, expect } from 'vitest';
import { assertSequenceFinalizable, SequenceIntegrityError } from '../src/lib/sequence-management';

describe('Sequence integrity gate', () => {
  describe('rejects true out-of-order corruption', () => {
    it('throws when the issued series contains a gap', () => {
      expect(() => assertSequenceFinalizable({ valid: false, gaps: [7] })).toThrow(SequenceIntegrityError);
    });

    it('reports the missing numbers so the ledger break is auditable', () => {
      try {
        assertSequenceFinalizable({ valid: false, gaps: [7, 8] });
        expect.unreachable('expected a SequenceIntegrityError');
      } catch (error) {
        expect(error).toBeInstanceOf(SequenceIntegrityError);
        expect((error as SequenceIntegrityError).code).toBe('sequence_out_of_order');
        expect((error as SequenceIntegrityError).details.gaps).toEqual([7, 8]);
      }
    });
  });

  describe('rejects an unverifiable series', () => {
    it('throws when integrity could not be established', () => {
      // Fail closed: if we cannot prove the series is intact, we must not
      // append to it.
      expect(() => assertSequenceFinalizable({ valid: false, error: 'D1 read failed' })).toThrow(
        SequenceIntegrityError,
      );
    });

    it('distinguishes an unverifiable series from a detected gap', () => {
      try {
        assertSequenceFinalizable({ valid: false, error: 'D1 read failed' });
        expect.unreachable('expected a SequenceIntegrityError');
      } catch (error) {
        expect((error as SequenceIntegrityError).code).toBe('sequence_unverifiable');
      }
    });
  });

  describe('permits finalization on an intact series', () => {
    it('does not throw when the series is valid', () => {
      expect(() => assertSequenceFinalizable({ valid: true })).not.toThrow();
    });

    it('does not throw when validation reports no gaps', () => {
      expect(() => assertSequenceFinalizable({ valid: true, gaps: undefined })).not.toThrow();
    });
  });

  describe('does not treat transient contention as corruption', () => {
    it('leaves queueing to the caller rather than rejecting', () => {
      // A lock/race surfaces as a failed *claim*, not as an invalid series.
      // An intact series must stay finalizable so the retry path can proceed.
      expect(() => assertSequenceFinalizable({ valid: true })).not.toThrow();
    });
  });
});
