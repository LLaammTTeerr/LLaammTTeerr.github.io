import { describe, it, expect } from 'vitest';
import { monthOf, lastDayOfMonth, nextMonth, monthRange } from '../../src/chain/period';

describe('monthOf', () => {
  it('extracts YYYY-MM', () => {
    expect(monthOf('2026-07-28')).toBe('2026-07');
  });
});

describe('lastDayOfMonth', () => {
  it('handles a 31-day month', () => {
    expect(lastDayOfMonth('2026-07')).toBe('2026-07-31');
  });

  it('handles a 30-day month', () => {
    expect(lastDayOfMonth('2026-06')).toBe('2026-06-30');
  });

  it('handles a non-leap February', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
  });

  it('handles a leap February', () => {
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29');
  });

  it('handles December', () => {
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
  });

  it('throws on a non-numeric month instead of returning garbage', () => {
    expect(() => lastDayOfMonth('2026-xx')).toThrow();
  });
});

describe('nextMonth', () => {
  it('advances within a year', () => {
    expect(nextMonth('2026-07')).toBe('2026-08');
  });

  it('rolls over the year boundary', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
  });
});

describe('monthRange', () => {
  it('is inclusive of from and exclusive of to', () => {
    expect(monthRange('2026-05', '2026-08')).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('returns empty when from equals to', () => {
    expect(monthRange('2026-05', '2026-05')).toEqual([]);
  });

  it('returns empty when from is after to', () => {
    expect(monthRange('2026-09', '2026-05')).toEqual([]);
  });

  it('crosses a year boundary', () => {
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});
