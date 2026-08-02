import { lastDayOfMonth, monthOf, monthRange, nextMonth } from './period';
import type { Transaction } from './types';

export interface BlockDraft {
  period: string; // YYYY-MM
  transactions: Transaction[];
}

export interface PlanOptions {
  /**
   * The last sealed block's period — the first period still open — or null if
   * the chain is empty. It is NOT the month after the last sealed block: a
   * month may be sealed and still take further blocks, as the remainder of a
   * size-limit split or as the landing place for a backdated post.
   */
  fromPeriod: string | null;
  /** Injected clock, YYYY-MM-DD. The ONLY time input to the engine. */
  now: string;
  maxTxPerBlock: number;
}

/**
 * §5 — ordinary transactions by date then slug; amendments last, ordered by
 * the hash they amend. Amendments carry the date of the older post they amend,
 * so sorting them by date would scatter them among unrelated posts.
 */
/**
 * Codepoint order, deliberately NOT `localeCompare`.
 *
 * `localeCompare` with no locale resolves against ambient ICU, so `LC_ALL`
 * changes it. Collation disagrees with codepoint order in several locales —
 * under Czech `"chi".localeCompare("hi")` is +1 while codepoint order says -1,
 * and `ch-` initial slugs are everywhere in Vietnamese; even in the default
 * en-US locale `"Beta".localeCompare("alpha")` is +1. Two posts sharing a date
 * would then order differently on a different machine, changing the Merkle
 * root and the block hash. Ordering must depend on nothing but the input.
 */
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function orderWithinBlock(txs: Transaction[]): Transaction[] {
  const posts = txs.filter((t) => t.type !== 'amendment');
  const amendments = txs.filter((t) => t.type === 'amendment');
  posts.sort(
    (a, b) =>
      byCodepoint(a.date, b.date) ||
      byCodepoint(a.slug ?? '', b.slug ?? '') ||
      byCodepoint(a.hash, b.hash),
  );
  amendments.sort(
    (a, b) => byCodepoint(a.amends ?? '', b.amends ?? '') || byCodepoint(a.hash, b.hash),
  );
  return [...posts, ...amendments];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Lexicographic max over zero-padded YYYY-MM periods. */
function maxPeriod(a: string, b: string): string {
  return a > b ? a : b;
}

/** Lexicographic min over zero-padded YYYY-MM periods. */
function minPeriod(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * §3.6 — decide which blocks are ready to seal.
 *
 * A block seals when it reaches maxTxPerBlock transactions, or when its
 * calendar month has ended. Complete months with no posts still mint an empty
 * block. The current month is never sealed on the time rule, because it is
 * still open.
 */
export function planBlocks(pending: Transaction[], opts: PlanOptions): BlockDraft[] {
  if (!Number.isInteger(opts.maxTxPerBlock) || opts.maxTxPerBlock <= 0) {
    throw new Error(
      `maxTxPerBlock must be a positive integer, got ${opts.maxTxPerBlock}`,
    );
  }

  const currentPeriod = monthOf(opts.now);

  const txPeriods = pending.map((t) => monthOf(t.date)).sort();
  const earliestTxPeriod = txPeriods[0] ?? null;

  // The first period still open for new blocks. Everything before it is
  // sealed and immutable. On an empty chain it is the earliest transaction's
  // month — but never a future one, or genesis itself would be minted into a
  // month that has not started.
  const firstOpenPeriod =
    opts.fromPeriod ??
    (earliestTxPeriod === null ? null : minPeriod(earliestTxPeriod, currentPeriod));
  if (firstOpenPeriod === null) return [];

  // A transaction can never join a month that has not started yet. Without
  // this upper bound a single future-dated post seals a block in its own
  // future month; `fromPeriod` then jumps to that month, every later
  // transaction clamps into it, and — being neither past nor full — it never
  // seals. No block is ever minted again until real time catches up, and
  // sealed blocks cannot be undone. `firstOpenPeriod` still wins if the chain
  // itself has somehow reached beyond the current month: the lower bound
  // protects sealed months and must not be violated by the upper one.
  const latestOpenPeriod = maxPeriod(currentPeriod, firstOpenPeriod);

  const byPeriod = new Map<string, Transaction[]>();
  for (const tx of pending) {
    // Block membership is "when it entered the chain", not "what date it
    // claims". An amendment carries the date of the post it amends, a post
    // may be backdated, and a post may be dated into the future; none of them
    // may reopen a sealed month or open an unstarted one.
    const period = minPeriod(maxPeriod(monthOf(tx.date), firstOpenPeriod), latestOpenPeriod);
    const bucket = byPeriod.get(period);
    if (bucket) bucket.push(tx);
    else byPeriod.set(period, [tx]);
  }

  const latestBucket = [...byPeriod.keys()].sort().at(-1) ?? firstOpenPeriod;
  // Walk to the month after the later of "latest bucket" and "now", so the
  // current month is still visited (the size rule can fire there) while
  // silent months in between are not skipped.
  const endExclusive = nextMonth(maxPeriod(latestBucket, currentPeriod));

  const drafts: BlockDraft[] = [];
  for (const period of monthRange(firstOpenPeriod, endExclusive)) {
    const txs = orderWithinBlock(byPeriod.get(period) ?? []);
    const isPast = period < currentPeriod;

    if (txs.length === 0) {
      if (isPast) drafts.push({ period, transactions: [] });
      continue;
    }

    const groups = chunk(txs, opts.maxTxPerBlock);
    for (const group of groups) {
      const isFull = group.length === opts.maxTxPerBlock;
      // A partial group in the current month stays pending.
      if (isFull || isPast) drafts.push({ period, transactions: group });
    }
  }

  return drafts;
}

/**
 * §3.4 — timestamps derive from content, never from build time, and never
 * decrease along the chain.
 */
export function blockTimestamp(draft: BlockDraft, prevTimestamp: string | null): string {
  const contentDate =
    draft.transactions.length === 0
      ? lastDayOfMonth(draft.period)
      : draft.transactions.map((t) => t.date).sort().at(-1)!;

  const candidate = `${contentDate}T00:00:00Z`;
  if (prevTimestamp !== null && prevTimestamp > candidate) return prevTimestamp;
  return candidate;
}
