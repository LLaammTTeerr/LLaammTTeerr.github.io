/**
 * Calendar arithmetic on `YYYY-MM` periods and `YYYY-MM-DD` dates.
 * All arithmetic is UTC. No function here reads the clock.
 */

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

function parsePeriod(period: string): { year: number; month: number } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new Error(`invalid period: ${period}`);
  }
  return { year, month };
}

function formatPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function lastDayOfMonth(period: string): string {
  const { year, month } = parsePeriod(period);
  // Day 0 of the following month is the last day of this one.
  const d = new Date(Date.UTC(year, month, 0));
  return `${period}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function nextMonth(period: string): string {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

/** Ascending periods from `from` inclusive to `toExclusive` exclusive. */
export function monthRange(from: string, toExclusive: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor < toExclusive) {
    out.push(cursor);
    cursor = nextMonth(cursor);
  }
  return out;
}
