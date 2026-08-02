import { lastDayOfMonth, monthOf, monthRange, nextMonth } from './period';
import type { Hex, Transaction } from './types';

export interface BlockDraft {
  period: string; // YYYY-MM
  transactions: Transaction[];
}

export interface PlanOptions {
  /**
   * The last sealed block's period, or null if the chain is empty.
   *
   * This is where the month *walk* starts, and it is NOT the month after the
   * last sealed block: the walk must revisit the tip's own month so silent
   * completed months between it and now still mint their empty blocks (§3.6).
   *
   * It is deliberately not where a transaction may *land*. Once the tip's
   * month has also ended it is closed, and a transaction entering the chain
   * now goes to the first still-open month instead — see `membershipFloor` in
   * `planBlocks`. Within a single build a busy month can still split into two
   * blocks of the same period; what cannot happen is a closed month gaining
   * another block on a later build.
   */
  fromPeriod: string | null;
  /** Injected clock, YYYY-MM-DD. The ONLY time input to the engine. */
  now: string;
  maxTxPerBlock: number;
  /**
   * Transaction hash to the period it was *already* recorded in, from
   * `chain.pending.json`.
   *
   * Placement has to be a recorded fact rather than something recomputed from
   * the clock on every build. Recomputed, a partial block never seals at any
   * clock: each build re-places its transactions into the then-current month,
   * and the current month is never past, so the month-end half of
   * `isFull || isPast` can never fire. The transaction slides forward forever
   * while its month mints an *empty* block behind it, recording as silent a
   * month that in fact held a pending transaction.
   *
   * Recorded, `2026-07` stays `2026-07`, and the month-end rule fires normally
   * the moment that month is past.
   */
  recordedPeriods?: ReadonlyMap<Hex, string>;
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

export interface ChainPlan {
  /** Blocks ready to seal now. */
  drafts: BlockDraft[];
  /**
   * The still-open block: transactions that have been *placed* in a period but
   * whose block has neither filled nor reached its month's end. Null when
   * nothing is waiting. Its period is what must be recorded, so the next build
   * places these transactions where this one did instead of re-deriving it.
   */
  open: BlockDraft | null;
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
  return planChain(pending, opts).drafts;
}

/**
 * As `planBlocks`, but also reports the block left open.
 *
 * Callers that persist the open block need its period, and re-deriving that
 * period outside this function is precisely the bug this design removes: two
 * implementations of "where does this transaction go" drift, and placement
 * recomputed against a later clock slides forward forever.
 */
export function planChain(pending: Transaction[], opts: PlanOptions): ChainPlan {
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
  if (firstOpenPeriod === null) return { drafts: [], open: null };

  // A transaction can never join a month that has not started yet. Without
  // this upper bound a single future-dated post seals a block in its own
  // future month; `fromPeriod` then jumps to that month, every later
  // transaction clamps into it, and — being neither past nor full — it never
  // seals. No block is ever minted again until real time catches up, and
  // sealed blocks cannot be undone. `firstOpenPeriod` still wins if the chain
  // itself has somehow reached beyond the current month: the lower bound
  // protects sealed months and must not be violated by the upper one.
  const latestOpenPeriod = maxPeriod(currentPeriod, firstOpenPeriod);

  // Where a transaction ENTERING the chain now may land, as distinct from the
  // months this build walks. The walk must still start at the tip so silent
  // completed months mint their empty blocks (§3.6); placement must not, or a
  // month that already sealed would quietly gain a transaction afterwards.
  //
  // On an empty chain there is no tip and genesis bootstraps at the earliest
  // transaction's own month, so the floor stays where `firstOpenPeriod` put it.
  const membershipFloor =
    opts.fromPeriod === null ? firstOpenPeriod : maxPeriod(firstOpenPeriod, currentPeriod);

  const byPeriod = new Map<string, Transaction[]>();
  for (const tx of pending) {
    // Block membership is "when it entered the chain", not "what date it
    // claims". An amendment carries the date of the post it amends, a post
    // may be backdated, and a post may be dated into the future; none of them
    // may reopen a sealed month or open an unstarted one.
    // A period already recorded for this transaction wins: it is where the
    // transaction entered the chain, and re-deriving it from the clock is what
    // makes a partial block slide forward forever. It is still floored by
    // `firstOpenPeriod`, so a stale pending file naming a since-sealed month
    // cannot reopen it.
    const recorded = opts.recordedPeriods?.get(tx.hash);
    const period = recorded !== undefined
      ? maxPeriod(recorded, firstOpenPeriod)
      : minPeriod(maxPeriod(monthOf(tx.date), membershipFloor), latestOpenPeriod);
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
  let open: BlockDraft | null = null;
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
      // A partial group in a month that has not ended stays pending. Only the
      // last group of one still-open period can land here: every earlier group
      // is full, and every earlier period is past.
      if (isFull || isPast) drafts.push({ period, transactions: group });
      else open = { period, transactions: group };
    }
  }

  return { drafts, open };
}

/**
 * §3.4 — timestamps derive from content, never from build time, and never
 * decrease along the chain.
 *
 * The content date is also bounded by the block's own period: a future-dated
 * transaction is already placed in the current open period (see
 * `planBlocks`), so without this bound its date would leak into the block's
 * timestamp and, via the monotonic clamp below, into every later block too —
 * permanently poisoning the chain's timestamps from one stray future post.
 */
export function blockTimestamp(draft: BlockDraft, prevTimestamp: string | null): string {
  const periodLastDay = lastDayOfMonth(draft.period);
  const latestTxDate =
    draft.transactions.length === 0
      ? periodLastDay
      : draft.transactions.map((t) => t.date).sort().at(-1)!;
  // `YYYY-MM-DD` sorts lexicographically the same as it sorts chronologically,
  // so plain string comparison suffices (see `minPeriod`/`maxPeriod` above,
  // which rely on the same fact for `YYYY-MM` periods).
  const contentDate = latestTxDate < periodLastDay ? latestTxDate : periodLastDay;

  const candidate = `${contentDate}T00:00:00Z`;
  if (prevTimestamp !== null && prevTimestamp > candidate) return prevTimestamp;
  return candidate;
}
