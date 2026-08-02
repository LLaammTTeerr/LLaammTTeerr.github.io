import { describe, it, expect } from 'vitest';
import { planBlocks, blockTimestamp } from '../../src/chain/seal';
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
    gasUsed: 100,
    value: 1,
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

  it('is a no-op when re-run at the same clock', () => {
    const txs = [tx('2026-07-01', 'a')];
    expect(planBlocks(txs, OPTS)).toEqual(planBlocks(txs, OPTS));
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
    const drafts = planBlocks([amendment], {
      maxTxPerBlock: 4,
      fromPeriod: '2026-08',
      now: '2026-09-15',
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.period).toBe('2026-08');
    expect(drafts[0]!.transactions).toEqual([amendment]);
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
    const drafts = planBlocks([backdated], {
      maxTxPerBlock: 4,
      fromPeriod: '2026-08',
      now: '2026-09-15',
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.period).toBe('2026-08');
    expect(drafts[0]!.transactions).toEqual([backdated]);
    expect(drafts[0]!.transactions[0]!.date).toBe('2026-01-05');
  });

  it('still seals the remainder of a size-limit split in its own month', () => {
    const remainder = tx('2026-08-05', 'e');
    const drafts = planBlocks([remainder], {
      maxTxPerBlock: 4,
      fromPeriod: '2026-08',
      now: '2026-09-01',
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.period).toBe('2026-08');
    expect(drafts[0]!.transactions).toEqual([remainder]);
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
});
