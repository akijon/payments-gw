import { describe, it, expect } from 'vitest';
import { validateTermsInput, TERMS_VERSION } from '../src/lib/terms';

describe('validateTermsInput', () => {
  it('accepts true with the current terms version', () => {
    expect(validateTermsInput(true, TERMS_VERSION)).toEqual({ ok: true });
  });

  it('rejects false as terms_not_accepted', () => {
    expect(validateTermsInput(false, TERMS_VERSION)).toMatchObject({ ok: false, code: 'terms_not_accepted' });
  });

  it('rejects a missing value as terms_not_accepted', () => {
    expect(validateTermsInput(undefined, TERMS_VERSION)).toMatchObject({ ok: false, code: 'terms_not_accepted' });
  });

  it("rejects the string 'true' as terms_not_accepted (no type coercion)", () => {
    expect(validateTermsInput('true', TERMS_VERSION)).toMatchObject({ ok: false, code: 'terms_not_accepted' });
  });

  it('rejects a wrong version as terms_version_mismatch', () => {
    expect(validateTermsInput(true, '1970-01-01')).toMatchObject({ ok: false, code: 'terms_version_mismatch' });
  });

  it('rejects a missing version as terms_version_mismatch', () => {
    expect(validateTermsInput(true, undefined)).toMatchObject({ ok: false, code: 'terms_version_mismatch' });
  });
});
