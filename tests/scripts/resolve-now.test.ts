import { describe, it, expect } from 'vitest';
import { resolveNow } from '../../scripts/resolve-now';

describe('resolveNow', () => {
  it('accepts --now=YYYY-MM-DD', () => {
    expect(resolveNow(['--now=2026-08-02'])).toBe('2026-08-02');
  });

  it('falls back to today when no --now flag is given', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(resolveNow([])).toBe(today);
  });

  it('rejects a bare --now with no value', () => {
    expect(() => resolveNow(['--now'])).toThrow(/usage: --now=YYYY-MM-DD/);
  });

  it('rejects --now passed with a space instead of "="', () => {
    expect(() => resolveNow(['--now', '2026-08-02'])).toThrow(/usage: --now=YYYY-MM-DD/);
  });

  it('rejects a malformed date value', () => {
    expect(() => resolveNow(['--now=08-02-2026'])).toThrow(/YYYY-MM-DD/);
  });

  it('rejects an unrecognized flag instead of silently ignoring it', () => {
    expect(() => resolveNow(['--force'])).toThrow(/unrecognized argument/);
  });

  it('rejects an unrecognized flag alongside a valid --now', () => {
    expect(() => resolveNow(['--now=2026-08-02', '--force'])).toThrow(/unrecognized argument/);
  });
});
