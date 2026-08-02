/**
 * The clock enters the system here and nowhere else. `--now=YYYY-MM-DD`
 * overrides it, which is what makes reproducible builds possible — so a
 * malformed or misspelled flag must fail loudly rather than silently fall
 * back to today's date and mint real blocks against the wrong clock.
 */
export function resolveNow(argv: string[]): string {
  const nowFlag = argv.find((a) => a === '--now' || a.startsWith('--now='));

  const unrecognized = argv.filter((a) => a.startsWith('--') && a !== nowFlag);
  if (unrecognized.length > 0) {
    throw new Error(`unrecognized argument "${unrecognized[0]}" — usage: --now=YYYY-MM-DD`);
  }

  if (nowFlag === undefined) return new Date().toISOString().slice(0, 10);

  if (!nowFlag.startsWith('--now=')) {
    // A bare `--now`, or `--now 2026-08-02` passed as two argv entries
    // (space instead of `=`), lands here rather than being silently ignored.
    throw new Error(`--now requires a value joined with "=" — usage: --now=YYYY-MM-DD`);
  }

  const value = nowFlag.slice('--now='.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--now must be YYYY-MM-DD, got "${value}"`);
  }
  return value;
}
