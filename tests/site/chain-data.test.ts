import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHAIN_CONFIG } from '../../chain.config';
import { shortHash, splitHashWork } from '../../src/site/chain-data';
import {
  getChain, getBlocks, getBlock, getPosts, getAssets, getStats,
  workRatio, expectedAttempts, getPendingBlock, researchHours,
} from '../../src/site/chain-data';
import { readPending, type PendingLock } from '../../src/chain/pending';
import type { Transaction } from '../../src/chain/types';

// `getPendingBlock` reads a recorded file via `readPending`, with no
// arguments and no injectable path — it always reads the real
// `chain.pending.json` at the repo root. Mocking `readPending` (rather than
// writing that file in place) lets these tests control what it returns
// without touching the real working tree, which `astro build` sandboxes
// elsewhere in this suite (`tests/site/sandbox.ts`) go out of their way to
// avoid for exactly this reason. `isStale` and everything else in the module
// stay real, so the staleness check under test is the actual implementation.
vi.mock('../../src/chain/pending', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chain/pending')>();
  return { ...actual, readPending: vi.fn() };
});

describe('expectedAttempts', () => {
  it('is 16^difficulty', () => {
    expect(expectedAttempts(1)).toBe(16);
    expect(expectedAttempts(5)).toBe(1048576);
  });
});

describe('workRatio', () => {
  it('is nonce over expected attempts', () => {
    expect(workRatio(1048576, 5)).toBeCloseTo(1, 6);
    expect(workRatio(2097152, 5)).toBeCloseTo(2, 6);
  });

  it('reports a lucky block as under one', () => {
    expect(workRatio(198676, 5)).toBeLessThan(1);
  });
});

describe('splitHashWork', () => {
  it('splits the marker, the proven zeros, and everything after', () => {
    expect(splitHashWork('0x00000b1ea722', 5)).toEqual({
      marker: '0x',
      zeros: '00000',
      rest: 'b1ea722',
    });
  });

  it('reconstructs the input and highlights exactly `difficulty` zeros for a real committed block', () => {
    // Pins the split against the actual chain rather than a hand-built
    // string, so a mismatch between `difficulty` and what the hash really
    // starts with (a bug in either place) would show up here.
    const newest = getBlocks()[0]!;
    const work = splitHashWork(newest.shortHash, newest.difficulty);
    expect(work.marker + work.zeros + work.rest).toBe(newest.shortHash);
    expect(work.zeros).toBe('0'.repeat(newest.difficulty));
  });

  it('clamps to the string available rather than slicing past its end', () => {
    expect(splitHashWork('0x00', 5)).toEqual({ marker: '0x', zeros: '00', rest: '' });
  });

  it('clamps to the hex a shortHash still shows, not to the whole string', () => {
    // The caller (BlockCard) passes a `shortHash`, where only six hex
    // characters precede the `…`. Clamping against the string length painted
    // the ellipsis as a proven zero at difficulty 7 and a real hex digit from
    // the hash's tail at difficulty 8 — both reachable, since §3.4 makes the
    // chain's difficulty configurable and lets a block commit to a stricter
    // target than the floor.
    const short = shortHash(`0x${'0'.repeat(8)}${'b'.repeat(56)}`);
    expect(short).toBe('0x000000…bbbbbb');
    for (const difficulty of [7, 8, 20]) {
      const work = splitHashWork(short, difficulty);
      expect(work.zeros, `difficulty ${difficulty} overclaimed the visible proof`).toBe('000000');
      expect(work.rest).toBe('…bbbbbb');
    }
  });

  it('marks nothing but zeros at any difficulty, for the shape the caller passes', () => {
    // The invariant the whole highlight rests on: every marked character is
    // one the miner had to find. BlockCard always passes a `shortHash`, which
    // shows six hex characters — so however strict a block's committed target,
    // at most those six can be presented as proof, and never the `…`.
    const short = shortHash(`0x${'0'.repeat(8)}${'b'.repeat(56)}`);
    for (let difficulty = 0; difficulty <= 20; difficulty++) {
      const work = splitHashWork(short, difficulty);
      expect(work.zeros, `difficulty ${difficulty} marked a non-zero character`).toMatch(/^0*$/);
      expect(work.marker + work.zeros + work.rest, 'the split lost or duplicated characters').toBe(short);
    }
  });

  it('treats a zero or negative difficulty as no highlighted prefix', () => {
    expect(splitHashWork('0x00000abc', 0)).toEqual({ marker: '0x', zeros: '', rest: '00000abc' });
    expect(splitHashWork('0x00000abc', -3)).toEqual({ marker: '0x', zeros: '', rest: '00000abc' });
  });
});

describe('researchHours', () => {
  it('formats a declared figure at one decimal place, as the ledger serializes it', () => {
    expect(researchHours(1)).toBe('1.0');
    expect(researchHours(12.5)).toBe('12.5');
  });

  it('refuses to format the default as a figure', () => {
    // §3.8: `research` is optional and "defaults to 0.0, which displays as —
    // rather than a misleading 0". Returning null rather than '0.0' means a
    // caller cannot print the default by accident: there is no number to print.
    expect(researchHours(0)).toBeNull();
  });

  it('reports the declared hours of the one post on the committed chain', () => {
    expect(researchHours(getPosts()[0]!.value)).toBe('1.0');
  });
});

describe('getChain', () => {
  it('reads the committed ledger', () => {
    const chain = getChain();
    expect(chain.version).toBe(1);
    expect(Array.isArray(chain.blocks)).toBe(true);
    expect(Array.isArray(chain.assets)).toBe(true);
  });

  it('returns the same object on repeated calls', () => {
    expect(getChain()).toBe(getChain());
  });
});

describe('getBlocks', () => {
  it('returns blocks newest first', () => {
    const heights = getBlocks().map((b) => b.height);
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
  });

  it('includes every block', () => {
    expect(getBlocks()).toHaveLength(getChain().blocks.length);
  });

  it('carries presentation fields', () => {
    const newest = getBlocks()[0]!;
    expect(typeof newest.isGenesis).toBe('boolean');
    expect(typeof newest.isEmpty).toBe('boolean');
    expect(typeof newest.workRatio).toBe('number');
    expect(newest.shortHash).toMatch(/^0x[0-9a-f]{6}…[0-9a-f]{6}$/);
  });

  it('marks the genesis block and only the genesis block', () => {
    const flagged = getBlocks().filter((b) => b.isGenesis);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.height).toBe(0);
  });

  it('marks an empty block by transaction count', () => {
    for (const b of getBlocks()) {
      expect(b.isEmpty).toBe(b.transactions.length === 0);
    }
  });
});

describe('getBlock', () => {
  it('finds a block by height', () => {
    expect(getBlock(0)?.height).toBe(0);
  });

  it('returns undefined for a height that does not exist', () => {
    expect(getBlock(9999)).toBeUndefined();
  });
});

describe('getPosts', () => {
  it('excludes amendments', () => {
    expect(getPosts().every((t) => t.type === 'post')).toBe(true);
  });

  it('returns posts newest first by date', () => {
    const dates = getPosts().map((p) => p.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe('getStats', () => {
  // These pin concrete numbers from the committed ledger. Re-deriving the
  // expectation with the implementation's own expression cannot catch a
  // conceptual error — it passed happily while `height` reported the block
  // count (2) for a chain whose tip says #1, and while `transactions`
  // reported the post count under a tile labelled Transactions.
  it('reports the committed height of the tip, not the number of blocks', () => {
    expect(getChain().blocks).toHaveLength(2);
    expect(getStats().height).toBe(1);
    expect(getStats().height).toBe(getBlocks()[0]!.height);
  });

  it("counts every transaction from the headers' committed txCount", () => {
    // Amendments are transactions too (§3.9): committed to merkleRoot and
    // counted in txCount. A post count agrees only while the ledger holds
    // none, and would disagree with the block pages on the first one.
    const committed = getChain().blocks.reduce((n, b) => n + b.txCount, 0);
    expect(committed).toBe(1);
    expect(getStats().transactions).toBe(1);
    expect(getStats().transactions).toBe(committed);
  });

  it('counts the assets in the committed registry', () => {
    expect(getStats().assets).toBe(0);
    expect(getStats().assets).toBe(getChain().assets.length);
  });

  it('counts distinct addresses across from and to', () => {
    const seen = new Set<string>();
    for (const b of getChain().blocks) {
      for (const t of b.transactions) {
        seen.add(t.from);
        for (const to of t.to) seen.add(to);
      }
    }
    expect(getStats().addresses).toBe(seen.size);
  });

  // Pins a concrete number from the committed ledger rather than
  // re-deriving it with the same walk as the implementation — a shared
  // conceptual mistake in both would otherwise pass silently.
  it('counts exactly the two addresses in the committed ledger', () => {
    expect(getStats().addresses).toBe(2);
  });

  it('reports the chain difficulty', () => {
    expect(getStats().difficulty).toBe(5);
    expect(getStats().difficulty).toBe(getChain().difficulty);
  });
});

describe('cache immutability', () => {
  it('freezes the chain, its blocks, transactions, and asset registry', () => {
    const chain = getChain();
    expect(Object.isFrozen(chain)).toBe(true);
    expect(Object.isFrozen(chain.blocks)).toBe(true);
    expect(Object.isFrozen(chain.assets)).toBe(true);
    for (const block of chain.blocks) {
      expect(Object.isFrozen(block)).toBe(true);
      expect(Object.isFrozen(block.transactions)).toBe(true);
      for (const tx of block.transactions) expect(Object.isFrozen(tx)).toBe(true);
    }
  });

  it('throws rather than silently accepting a mutation on a returned transaction', () => {
    const post = getPosts()[0]!;
    const originalHash = post.hash;
    expect(() => {
      (post as { hash: string }).hash = 'mutated';
    }).toThrow(TypeError);
    // Not just "it threw" — the cache a later page reads must be unchanged.
    expect(getPosts()[0]!.hash).toBe(originalHash);
    expect(getChain().blocks.flatMap((b) => b.transactions)[0]!.hash).toBe(originalHash);
  });

  it("throws rather than silently accepting a mutation on a returned block's transactions array", () => {
    const block = getBlocks().find((b) => b.transactions.length > 0)!;
    const originalLength = block.transactions.length;
    expect(() => {
      block.transactions.push(block.transactions[0]!);
    }).toThrow(TypeError);
    expect(getBlock(block.height)!.transactions).toHaveLength(originalLength);
    expect(getChain().blocks.find((b) => b.height === block.height)!.transactions).toHaveLength(
      originalLength,
    );
  });

  it('throws rather than silently accepting a mutation on the frozen asset registry', () => {
    // The committed ledger mints no assets yet, so there is no individual
    // AssetRecord to attempt to mutate — but the array itself must still
    // reject a push, since that would poison every later page's asset list.
    const originalLength = getChain().assets.length;
    expect(() => {
      getChain().assets.push({
        tokenId: 999,
        hash: '0xdeadbeef',
        file: 'nonexistent.png',
        mime: 'image/png',
        bytes: 0,
        mintedIn: 0,
      });
    }).toThrow(TypeError);
    expect(getAssets()).toHaveLength(originalLength);
    expect(getChain().assets).toHaveLength(originalLength);
  });
});

describe('getPendingBlock', () => {
  const HASH = '0x' + 'a'.repeat(64);
  const HASH2 = '0x' + 'b'.repeat(64);
  const ADDR = '0x' + 'c'.repeat(40);

  function pendingTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      hash: HASH,
      type: 'post',
      slug: 'bai-viet',
      title: 'Bài viết',
      date: '2026-08-05',
      tags: ['essay'],
      series: null,
      from: ADDR,
      to: [],
      contentHash: HASH2,
      assets: [],
      gasUsed: 12,
      value: 2,
      research: null,
      amends: null,
      ...overrides,
    };
  }

  // `prevHash` defaults to the real chain's actual tip, so the fixture reads
  // as fresh unless a test deliberately overrides it — the staleness test does.
  function pendingFixture(overrides: Partial<PendingLock> = {}): PendingLock {
    return {
      version: 1,
      period: '2026-08',
      height: getStats().height + 1,
      prevHash: getBlocks()[0]!.hash,
      transactions: [pendingTx()],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(readPending).mockReset();
  });

  it('returns null when no pending file exists', () => {
    vi.mocked(readPending).mockReturnValue(null);
    expect(getPendingBlock()).toBeNull();
  });

  it('exposes the recorded transactions with their recorded hashes', () => {
    // Not recomputed. The point of the file is that the site shows what
    // chain:build committed, so a hash on the page is one you can diff. HASH
    // and HASH2 are fabricated, not derivable from any real content — if the
    // implementation tried to recompute them from disk instead of trusting
    // the recorded file, this would not come back matching.
    const recorded = pendingTx({ hash: HASH, contentHash: HASH2 });
    vi.mocked(readPending).mockReturnValue(pendingFixture({ transactions: [recorded] }));

    const pending = getPendingBlock();
    expect(pending).not.toBeNull();
    expect(pending!.transactions).toEqual([recorded]);
    expect(pending!.transactions[0]!.hash).toBe(HASH);
    expect(pending!.transactions[0]!.contentHash).toBe(HASH2);
  });

  it('refuses a pending file written against a different tip', () => {
    // A stale file must not render as though it belonged to this chain.
    const foreignTip = '0x' + 'f'.repeat(64);
    expect(foreignTip).not.toBe(getBlocks()[0]!.hash);
    vi.mocked(readPending).mockReturnValue(pendingFixture({ prevHash: foreignTip }));
    expect(getPendingBlock()).toBeNull();
  });

  it('reports the month end as the seal date', () => {
    vi.mocked(readPending).mockReturnValue(pendingFixture({ period: '2026-08' }));
    expect(getPendingBlock()!.sealsOn).toBe('2026-08-31');
  });

  it('reports the last day of February, including a leap year', () => {
    // §sealsOn — arithmetic only, no clock. Pins both the common case and
    // the leap-year case so neither can silently regress to a fixed 28.
    vi.mocked(readPending).mockReturnValue(pendingFixture({ period: '2026-02' }));
    expect(getPendingBlock()!.sealsOn).toBe('2026-02-28');

    vi.mocked(readPending).mockReturnValue(pendingFixture({ period: '2024-02' }));
    expect(getPendingBlock()!.sealsOn).toBe('2024-02-29');
  });

  it('sums gasUsed and value across the recorded transactions', () => {
    const a = pendingTx({ hash: HASH, gasUsed: 10, value: 1 });
    const b = pendingTx({ hash: HASH2, slug: 'bai-hai', gasUsed: 20, value: 3 });
    vi.mocked(readPending).mockReturnValue(pendingFixture({ transactions: [a, b] }));

    const pending = getPendingBlock()!;
    expect(pending.txCount).toBe(2);
    expect(pending.gasUsed).toBe(30);
    expect(pending.value).toBe(4);
  });

  it('carries the recorded height and marks itself unsealed', () => {
    vi.mocked(readPending).mockReturnValue(pendingFixture({ height: 7 }));
    const pending = getPendingBlock()!;
    expect(pending.sealed).toBe(false);
    expect(pending.height).toBe(7);
  });

  it('reports maxTxPerBlock from the chain config, for the fill indicator', () => {
    vi.mocked(readPending).mockReturnValue(pendingFixture());
    expect(getPendingBlock()!.maxTxPerBlock).toBe(4);
    expect(getPendingBlock()!.maxTxPerBlock).toBe(CHAIN_CONFIG.maxTxPerBlock);
  });

  it('deep-freezes the returned view, like getChain', () => {
    vi.mocked(readPending).mockReturnValue(pendingFixture());
    const pending = getPendingBlock()!;
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.transactions)).toBe(true);
    expect(() => {
      (pending as { height: number }).height = 999;
    }).toThrow(TypeError);
  });
});
