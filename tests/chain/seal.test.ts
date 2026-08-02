import { describe, it, expect } from 'vitest';
import { planBlocks, planChain, txIdentity, blockTimestamp } from '../../src/chain/seal';
import type { Transaction } from '../../src/chain/types';

function tx(date: string, slug: string): Transaction {
  return {
    hash: `0x${slug}`,
    type: 'post',
    slug,
    title: slug,
    date,
    tags: [],
    series: null,
    from: '0xaaaa',
    to: [],
    contentHash: `0xc${slug}`,
    assets: [],
    gasUsed: 100,
    value: 1,
    research: null,
    amends: null,
  };
}

const OPTS = { maxTxPerBlock: 4, fromPeriod: null, now: '2026-08-02' };

describe('planBlocks', () => {
  it('returns nothing when there are no transactions and no prior chain', () => {
    expect(planBlocks([], OPTS)).toEqual([]);
  });

  it('seals a completed month into one block', () => {
    const txs = [tx('2026-07-01', 'a'), tx('2026-07-15', 'b')];
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.period).toBe('2026-07');
    expect(drafts[0]!.transactions.map((t) => t.slug)).toEqual(['a', 'b']);
  });

  it('does not seal the current month when under the size limit', () => {
    const txs = [tx('2026-08-01', 'a')];
    expect(planBlocks(txs, OPTS)).toEqual([]);
  });

  it('seals the current month once the size limit is reached', () => {
    const txs = ['a', 'b', 'c', 'd'].map((s, i) => tx(`2026-08-0${i + 1}`, s));
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.transactions).toHaveLength(4);
  });

  it('leaves the remainder pending after a size-limit seal in the current month', () => {
    const txs = ['a', 'b', 'c', 'd', 'e'].map((s, i) => tx(`2026-08-0${i + 1}`, s));
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.transactions.map((t) => t.slug)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('splits a busy past month into multiple blocks of at most maxTxPerBlock', () => {
    const txs = ['a', 'b', 'c', 'd', 'e'].map((s, i) => tx(`2026-07-0${i + 1}`, s));
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.transactions).toHaveLength(4);
    expect(drafts[1]!.transactions.map((t) => t.slug)).toEqual(['e']);
  });

  it('mints an empty block for a silent month between posts', () => {
    const txs = [tx('2026-05-10', 'a'), tx('2026-07-10', 'b')];
    const drafts = planBlocks(txs, OPTS);
    expect(drafts.map((d) => d.period)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(drafts[1]!.transactions).toEqual([]);
  });

  it('mints empty blocks for silent months after the last sealed block', () => {
    const drafts = planBlocks([], { ...OPTS, fromPeriod: '2026-05' });
    expect(drafts.map((d) => d.period)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(drafts.every((d) => d.transactions.length === 0)).toBe(true);
  });

  it('never seals the current month as an empty block', () => {
    const drafts = planBlocks([], { ...OPTS, fromPeriod: '2026-08' });
    expect(drafts).toEqual([]);
  });

  it('places every transaction exactly once, losing and duplicating none', () => {
    // This replaces `expect(planBlocks(txs, OPTS)).toEqual(planBlocks(txs,
    // OPTS))` — two calls to a pure function with identical arguments. `seal.ts`
    // reads no clock and holds no module state, so no mutation could ever make
    // the two sides disagree; it asserted determinism of `===` itself. Build
    // idempotence, which is what that test was reaching for, is pinned for real
    // in `build.test.ts` ("is byte-identical when re-run at the same clock" and
    // the pending-file equivalent), which re-read from disk.
    //
    // What planning genuinely owes its caller is conservation: a transaction
    // dropped here vanishes from the chain, and one placed twice is sealed
    // twice. The fixture spans a sealed month, a size split and the still-open
    // month, so every branch of the placement is crossed.
    const txs = [
      tx('2026-06-10', 'a'),
      ...['b', 'c', 'd', 'e', 'f'].map((s, i) => tx(`2026-07-0${i + 1}`, s)),
      tx('2026-08-01', 'g'),
    ];
    const { drafts, open } = planChain(txs, OPTS);
    // Anti-vacuity: all three branches really are exercised.
    expect(drafts.length, 'nothing sealed, so the split is untested').toBeGreaterThan(1);
    expect(open, 'nothing left open, so the open branch is untested').not.toBeNull();

    const placed = [...drafts.flatMap((d) => d.transactions), ...open!.transactions];
    expect(placed.map((t) => t.slug).sort()).toEqual(txs.map((t) => t.slug).sort());
    expect(new Set(placed.map((t) => t.slug)).size, 'a transaction was placed twice').toBe(
      placed.length,
    );
  });

  it('orders amendments after ordinary transactions within a block', () => {
    const amendment: Transaction = {
      ...tx('2026-07-01', 'z'),
      type: 'amendment',
      slug: null,
      title: null,
      amends: '0xolder',
      gasUsed: 0,
      value: 0,
    };
    const drafts = planBlocks([amendment, tx('2026-07-20', 'a')], OPTS);
    expect(drafts[0]!.transactions.map((t) => t.type)).toEqual(['post', 'amendment']);
  });

  it('places an amendment dated before fromPeriod into the first still-open period, not its own month', () => {
    const amendment: Transaction = {
      ...tx('2026-03-10', 'z'),
      type: 'amendment',
      slug: null,
      title: null,
      amends: '0xolder',
      gasUsed: 0,
      value: 0,
    };
    const opts = { maxTxPerBlock: 4, fromPeriod: '2026-08', now: '2026-09-15' };
    const drafts = planBlocks([amendment], opts);
    // It must not get a block in its own stale month, which is the point of
    // the membership floor.
    expect(drafts.map((d) => d.period)).not.toContain('2026-03');
    // §3.6 — the first still-open month is 2026-09, not the sealed tip 2026-08.
    // A lone transaction there is a partial group in the *current* month, so it
    // stays pending rather than sealing.
    expect(drafts.flatMap((d) => d.transactions)).toEqual([]);
    // It really is placed in 2026-09: once that month fills, it seals there.
    const filled = planBlocks(
      [amendment, tx('2026-09-01', 'a'), tx('2026-09-02', 'b'), tx('2026-09-03', 'c')],
      opts,
    );
    const sealed = filled.filter((d) => d.transactions.length > 0);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.period).toBe('2026-09');
    expect(sealed[0]!.transactions).toContain(amendment);
  });

  it('does not mint empty blocks for months before fromPeriod, even when a stale-dated tx exists', () => {
    const amendment: Transaction = {
      ...tx('2026-03-10', 'z'),
      type: 'amendment',
      slug: null,
      title: null,
      amends: '0xolder',
      gasUsed: 0,
      value: 0,
    };
    const drafts = planBlocks([amendment], {
      maxTxPerBlock: 4,
      fromPeriod: '2026-08',
      now: '2026-09-15',
    });
    // Without the fix this would propose a block for 2026-03 plus empty
    // blocks for 2026-04..2026-08 — months already sealed on the chain.
    expect(drafts.map((d) => d.period)).toEqual(['2026-08']);
  });

  it('places a post backdated before fromPeriod into the first still-open period, keeping its original date', () => {
    const backdated = tx('2026-01-05', 'old-post');
    const opts = { maxTxPerBlock: 4, fromPeriod: '2026-08', now: '2026-09-15' };
    const drafts = planBlocks([backdated], opts);
    expect(drafts.map((d) => d.period)).not.toContain('2026-01');
    // The first still-open month is 2026-09; a lone post there stays pending.
    expect(drafts.flatMap((d) => d.transactions)).toEqual([]);
    // Once 2026-09 fills, the backdated post seals there — carrying its own
    // date unchanged. Membership moves; the date it claims never does.
    const filled = planBlocks(
      [backdated, tx('2026-09-01', 'a'), tx('2026-09-02', 'b'), tx('2026-09-03', 'c')],
      opts,
    );
    const sealed = filled.filter((d) => d.transactions.length > 0);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.period).toBe('2026-09');
    expect(sealed[0]!.transactions.find((t) => t.slug === 'old-post')!.date).toBe('2026-01-05');
  });

  it('carries the remainder of a size-limit split into the open month once its own month has closed', () => {
    // Previously this sealed as a second 2026-08 block. That is the very bug
    // this rule closes: 2026-08 is sealed AND over, so appending to it would
    // mean a completed month gained a transaction after the fact. The
    // remainder joins the open month instead. Splitting a busy month into two
    // blocks *within one build* is untouched — see the size-rule test below.
    const remainder = tx('2026-08-05', 'e');
    const opts = { maxTxPerBlock: 4, fromPeriod: '2026-08', now: '2026-09-01' };
    const drafts = planBlocks([remainder], opts);
    expect(drafts.flatMap((d) => d.transactions)).toEqual([]);

    const filled = planBlocks(
      [remainder, tx('2026-09-01', 'a'), tx('2026-09-02', 'b'), tx('2026-09-03', 'c')],
      opts,
    );
    const sealed = filled.filter((d) => d.transactions.length > 0);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]!.period).toBe('2026-09');
    expect(sealed[0]!.transactions).toContain(remainder);
  });

  it('orders two amendments to the same post identically regardless of input order', () => {
    const amendment1: Transaction = {
      ...tx('2026-07-01', 'amend1'),
      type: 'amendment',
      slug: null,
      title: null,
      amends: '0xolder',
      gasUsed: 0,
      value: 0,
    };
    const amendment2: Transaction = {
      ...tx('2026-07-01', 'amend2'),
      type: 'amendment',
      slug: null,
      title: null,
      amends: '0xolder',
      gasUsed: 0,
      value: 0,
    };
    const forward = planBlocks([amendment1, amendment2], OPTS);
    const reversed = planBlocks([amendment2, amendment1], OPTS);
    expect(forward).toEqual(reversed);
    expect(forward[0]!.transactions.map((t) => t.hash)).toEqual(['0xamend1', '0xamend2']);
  });

  it('produces exactly one full block for a past month with exactly maxTxPerBlock transactions, no trailing empty block', () => {
    const txs = ['a', 'b', 'c', 'd'].map((s, i) => tx(`2026-07-0${i + 1}`, s));
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.period).toBe('2026-07');
    expect(drafts[0]!.transactions).toHaveLength(4);
  });

  it('never proposes a block for a month that has not started', () => {
    // A block sealed in a month that has not started sets fromPeriod to that
    // month; every later transaction then clamps into it, and a month that is
    // neither past nor full never seals. The chain would freeze until real
    // time caught up, and sealed blocks cannot be taken back.
    const drafts = planBlocks([tx('2027-03-04', 'future')], {
      maxTxPerBlock: 4,
      fromPeriod: '2026-08',
      now: '2026-09-10',
    });
    expect(drafts.every((d) => d.period <= '2026-09')).toBe(true);
    // It waits in the current open month rather than sealing 2027-03.
    expect(drafts.flatMap((d) => d.transactions)).toEqual([]);
  });

  it('seals future-dated posts into the current month once they fill a block', () => {
    const txs = ['a', 'b', 'c', 'd'].map((s, i) => tx(`2027-03-0${i + 1}`, s));
    const drafts = planBlocks(txs, {
      maxTxPerBlock: 4,
      fromPeriod: '2026-08',
      now: '2026-09-10',
    });
    const filled = drafts.filter((d) => d.transactions.length > 0);
    expect(filled).toHaveLength(1);
    expect(filled[0]!.period).toBe('2026-09');
    expect(filled[0]!.transactions).toHaveLength(4);
    expect(filled[0]!.transactions[0]!.date).toBe('2027-03-01');
  });

  it('does not mint genesis into a future month when every post is future-dated', () => {
    const drafts = planBlocks([tx('2027-03-04', 'future')], {
      maxTxPerBlock: 4,
      fromPeriod: null,
      now: '2026-09-10',
    });
    // The only open month is the current one, and it is not full, so nothing
    // seals — rather than sealing 2027-03 and freezing the chain.
    expect(drafts).toEqual([]);
  });

  it('orders same-date posts by codepoint, not by locale collation', () => {
    // localeCompare resolves against ambient ICU, so ordering would depend on
    // the machine's locale: en-US puts "alpha" before "Beta", and Czech puts
    // "hi" before "chi" while codepoint order says the opposite. A different
    // order means a different Merkle root and a different block hash.
    const drafts = planBlocks([tx('2026-07-01', 'alpha'), tx('2026-07-01', 'Beta')], OPTS);
    expect(drafts[0]!.transactions.map((t) => t.slug)).toEqual(['Beta', 'alpha']);
  });

  it('orders ch- initial slugs by codepoint', () => {
    const drafts = planBlocks([tx('2026-07-01', 'hi-mot'), tx('2026-07-01', 'chi-hai')], OPTS);
    expect(drafts[0]!.transactions.map((t) => t.slug)).toEqual(['chi-hai', 'hi-mot']);
  });

  it('places a transaction entering the chain today in the open month, not the tip month', () => {
    // Tip 2026-07 is sealed; an amendment carrying an old date enters on 2026-08-02.
    const drafts = planBlocks([tx('2026-06-15', 'old')], {
      now: '2026-08-02', maxTxPerBlock: 4, fromPeriod: '2026-07',
    });
    const withTxs = drafts.filter((d) => d.transactions.length > 0);
    expect(withTxs.map((d) => d.period)).not.toContain('2026-07');
  });

  it('still mints empty blocks for silent months between the tip and now', () => {
    // The regression that blocked the first attempt. Tip 2026-05, clock 2026-08:
    // 2026-06 and 2026-07 were silent but complete, so each must still get its
    // block. A month with no block is not "closed" — it is a hole in the chain.
    const drafts = planBlocks([tx('2026-06-15', 'old')], {
      now: '2026-08-02', maxTxPerBlock: 4, fromPeriod: '2026-05',
    });
    expect(drafts.map((d) => d.period)).toEqual(
      expect.arrayContaining(['2026-05', '2026-06', '2026-07']),
    );
  });

  it('still lets a busy current month split into two blocks of the same period', () => {
    // 8, not 5: a PARTIAL group in the open month stays pending (see the
    // `isFull || isPast` rule below), so 5 transactions yield ONE block. Eight
    // is the smallest input that actually produces two full groups.
    const many = Array.from({ length: 8 }, (_, i) =>
      tx(`2026-08-${String(i + 1).padStart(2, '0')}`, `p${i}`));
    const drafts = planBlocks(many, { now: '2026-08-20', maxTxPerBlock: 4, fromPeriod: '2026-08' });
    expect(drafts.filter((d) => d.period === '2026-08').length).toBe(2);
  });

  it('seals a block whose recorded period has ended, even with a partial group', () => {
    // The month-end rule must fire for 1-3 transactions. Without recorded
    // placement this is unreachable at ANY clock: the transaction is re-placed
    // into the current month on every build and the current month is never past.
    const t = tx('2026-07-05', 'p');
    const drafts = planBlocks([t], {
      now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07',
      recordedPeriods: new Map([[txIdentity(t), '2026-07']]),
    });
    const withTxs = drafts.filter((d) => d.transactions.length > 0);
    expect(withTxs.map((d) => d.period)).toEqual(['2026-07']);
  });

  it('does not mint an empty block for a month that held a pending transaction', () => {
    const t = tx('2026-07-05', 'p');
    const drafts = planBlocks([t], {
      now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07',
      recordedPeriods: new Map([[txIdentity(t), '2026-07']]),
    });
    expect(drafts.filter((d) => d.period === '2026-07' && d.transactions.length === 0)).toEqual([]);
  });

  it('gives a genuinely new transaction the current month, not its claimed date', () => {
    const t = tx('2026-06-15', 'backdated');
    const drafts = planBlocks([t], { now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07' });
    expect(drafts.filter((d) => d.transactions.length > 0).map((d) => d.period)).not.toContain('2026-07');
  });

  it('never lets a recorded period reopen a month the chain has already sealed', () => {
    // A stale or hand-edited file can name a month strictly before the tip —
    // sealed and gone. Such a record is dropped rather than clamped: clamping
    // it up to `firstOpenPeriod` would land the transaction in the TIP's own
    // month, minting a second block in a month that had already closed, which
    // is precisely what this test's name forbids.
    const t = tx('2026-05-05', 'p');
    const plan = planChain([t], {
      now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07',
      recordedPeriods: new Map([[txIdentity(t), '2026-05']]),
    });
    // Nothing seals: neither 2026-05 nor the tip's 2026-07 gains a block.
    expect(plan.drafts.filter((d) => d.transactions.length > 0)).toEqual([]);
    expect(plan.drafts.map((d) => d.period)).not.toContain('2026-05');
    // It is placed in the open month instead, exactly as if it were new.
    expect(plan.open!.period).toBe('2026-08');
    expect(plan.open!.transactions).toEqual([t]);
  });

  it('honours a recorded period equal to the tip, so a size-split remainder seals', () => {
    // Reached by an entirely honest sequence: five posts in one month seal four
    // and leave one open at that SAME period, so the record legitimately equals
    // the tip. Once the month ends that remainder must seal there — a month
    // being completed, not a closed one being reopened. Rejecting every record
    // at or below the tip would strand it forever.
    const t = tx('2026-07-05', 'e');
    const plan = planChain([t], {
      now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07',
      recordedPeriods: new Map([[txIdentity(t), '2026-07']]),
    });
    expect(plan.drafts.filter((d) => d.transactions.length > 0).map((d) => d.period)).toEqual([
      '2026-07',
    ]);
    expect(plan.open).toBeNull();
  });

  it('caps a recorded period that names a month which has not started', () => {
    // A hand-edited far-future period must not open an unstarted month, and
    // must not be re-persisted as the open block's period on the way out.
    const t = tx('2026-08-05', 'p');
    for (const recorded of ['2027-03', '9999-12']) {
      const plan = planChain([t], {
        now: '2026-08-20', maxTxPerBlock: 4, fromPeriod: '2026-07',
        recordedPeriods: new Map([[txIdentity(t), recorded]]),
      });
      expect(plan.open!.period).toBe('2026-08');
      expect(plan.drafts.every((d) => d.period <= '2026-08')).toBe(true);
    }
  });

  it('throws when maxTxPerBlock is zero', () => {
    expect(() => planBlocks([], { ...OPTS, maxTxPerBlock: 0 })).toThrow();
  });

  it('throws when maxTxPerBlock is not an integer', () => {
    expect(() => planBlocks([], { ...OPTS, maxTxPerBlock: 2.5 })).toThrow();
  });
});

describe('blockTimestamp', () => {
  it('uses the latest transaction date for a non-empty block', () => {
    const draft = { period: '2026-07', transactions: [tx('2026-07-01', 'a'), tx('2026-07-20', 'b')] };
    expect(blockTimestamp(draft, null)).toBe('2026-07-20T00:00:00Z');
  });

  it('uses the last day of the month for an empty block', () => {
    expect(blockTimestamp({ period: '2026-06', transactions: [] }, null)).toBe(
      '2026-06-30T00:00:00Z',
    );
  });

  it('never goes backwards from the previous block', () => {
    const draft = { period: '2026-07', transactions: [tx('2026-01-01', 'old')] };
    expect(blockTimestamp(draft, '2026-06-30T00:00:00Z')).toBe('2026-06-30T00:00:00Z');
  });

  it('advances past the previous block when the content is newer', () => {
    const draft = { period: '2026-07', transactions: [tx('2026-07-20', 'a')] };
    expect(blockTimestamp(draft, '2026-06-30T00:00:00Z')).toBe('2026-07-20T00:00:00Z');
  });

  it('bounds a future-dated transaction to its own period, not the transaction date', () => {
    // A future-dated post is already placed in the current open period by
    // `planBlocks`'s membership rule; its own block must not be stamped
    // beyond the period it actually belongs to.
    const draft = { period: '2026-09', transactions: [tx('2027-03-04', 'future')] };
    expect(blockTimestamp(draft, '2026-08-31T00:00:00Z')).toBe('2026-09-30T00:00:00Z');
  });

  it('does not let a poisoned timestamp propagate into later, unaffected blocks', () => {
    // Simulates the regression: a 2027-dated post used to make block 2026-09's
    // timestamp 2027-03-04, which then propagated via the monotonic clamp
    // into every later block forever. Now each block is bounded by its own
    // period, so the chain recovers.
    const b0709 = blockTimestamp(
      { period: '2026-09', transactions: [tx('2027-03-04', 'future')] },
      '2026-08-31T00:00:00Z',
    );
    expect(b0709).toBe('2026-09-30T00:00:00Z');

    const b0710 = blockTimestamp({ period: '2026-10', transactions: [] }, b0709);
    expect(b0710).toBe('2026-10-31T00:00:00Z');

    const b0711 = blockTimestamp(
      { period: '2026-11', transactions: [tx('2026-11-05', 'ordinary')] },
      b0710,
    );
    expect(b0711).toBe('2026-11-05T00:00:00Z');
  });
});
