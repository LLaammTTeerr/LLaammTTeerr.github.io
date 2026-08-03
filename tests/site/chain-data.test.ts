import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHAIN_CONFIG } from '../../chain.config';
import { shortHash, splitHashWork, txMetaLine, type RecordedTx } from '../../src/site/chain-data';
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

// The mock's default is "there is no pending file", which is what `readPending`
// returns for a repo with no open block and is the state most of this file
// assumes. A bare `vi.fn()` returns `undefined`, which is outside
// `readPending`'s declared `PendingLock | null` contract — so any caller
// checking `=== null` sails past it and dereferences nothing. That is not
// hypothetical: it took out seventeen tests here the moment `getStats` started
// consulting the open block, and the failure named a line inside the real
// `readPending`, which the mock means never runs.
beforeEach(() => {
  vi.mocked(readPending).mockReset();
  vi.mocked(readPending).mockReturnValue(null);
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

  it('highlights exactly the zeros a real committed block was mined to find', () => {
    // Pins the split against the actual chain rather than a hand-built string,
    // so a mismatch between `difficulty` and what the hash really starts with
    // (a bug in either place) would show up here.
    //
    // Reconstruction — `marker + zeros + rest === input` — used to stand here
    // and cannot fail: the three fields are contiguous slices of the input, so
    // it is true by construction for any implementation. What is real is that
    // the highlighted prefix is zeros the *committed mined hash* actually
    // carries, which is a fact about the ledger and not about the split.
    for (const block of getBlocks()) {
      const work = splitHashWork(block.shortHash, block.difficulty);
      expect(work.zeros, `block #${block.height}`).toBe('0'.repeat(block.difficulty));
      expect(
        block.hash.startsWith(`0x${work.zeros}`),
        `block #${block.height} highlighted zeros its mined hash does not have`,
      ).toBe(true);
      expect(block.difficulty, `block #${block.height} committed no proof of work`).toBeGreaterThan(0);
    }
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

  it('formats every figure the committed chain actually declares', () => {
    // Against the real ledger rather than a hand-built number, so the one
    // decimal place §3.8 asks for is checked against values the engine wrote.
    // Read over every post: naming "the one post on the chain" and its `1.0`
    // was a fact about a ledger that stops being true the day the author
    // publishes anything, and says nothing more than this does.
    const posts = getPosts();
    expect(posts.length, 'the committed ledger has no posts to check').toBeGreaterThan(0);
    for (const post of posts) {
      const hours = researchHours(post.value);
      if (post.value > 0) {
        expect(hours, `${post.slug}`).toMatch(/^\d+\.\d$/);
        expect(Number(hours), `${post.slug}`).toBeCloseTo(post.value, 5);
      } else {
        expect(hours, `${post.slug} declared nothing and was formatted anyway`).toBeNull();
      }
    }
  });
});

describe('txMetaLine', () => {
  const row = (overrides: Partial<RecordedTx>): RecordedTx => ({
    hash: '0x' + 'a'.repeat(64),
    type: 'post',
    slug: 'bai-viet',
    title: 'Bài viết',
    date: '2026-08-05',
    tags: [],
    series: null,
    from: '0x' + 'c'.repeat(40),
    to: [],
    contentHash: '0x' + 'b'.repeat(64),
    assets: [],
    gasUsed: 44,
    value: 1,
    research: null,
    amends: null,
    ...overrides,
  });

  it('shows a post its word count and its declared hours', () => {
    expect(txMetaLine(row({}))).toBe('44 từ · 1.0 giờ');
  });

  it('shows an em dash, not 0.0, for an undeclared research figure (§3.8)', () => {
    expect(txMetaLine(row({ value: 0 }))).toBe('44 từ · —');
  });

  it('omits a word count that could not be re-derived, rather than inventing one', () => {
    const line = txMetaLine(row({ gasUsed: null }));
    expect(line).toBe('— · 1.0 giờ');
    expect(line, 'a null word count rendered as a number').not.toMatch(/\d+ từ/);
  });

  it('says where an amendment\'s figures were counted instead of printing its zeros', () => {
    // §3.9 fixes an amendment's gasUsed and value at 0 so block aggregation
    // cannot re-charge the original's. Printed bare, `0 từ` reads as "this
    // post has no words" — and the post page shows the real count, derived
    // from the body the amendment commits to. Two pages disagreeing about one
    // transaction with nothing saying why is what this line prevents.
    const line = txMetaLine(row({ type: 'amendment', slug: null, gasUsed: 0, value: 0, research: 9.5 }));
    expect(line).toContain('đính chính');
    expect(line, 'an amendment printed its accounting zero as a word count').not.toContain('0 từ');
    expect(line).not.toMatch(/\d+ từ/);
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
  // On a one-transaction ledger `every(… === 'post')` and "already in date
  // order" were both vacuous — proved by mutation: deleting either the
  // `.filter` or the `.sort` from `getPosts` left this file green. Both
  // behaviours are discriminated on a mocked chain in
  // `tests/site/chain-data-longer-chain.test.ts`; stated here against the
  // ledger the site is actually built from, where a chain that has grown makes
  // them bite for real.
  it('returns exactly the post transactions the committed ledger holds', () => {
    const posts = getPosts();
    const committed = getChain()
      .blocks.flatMap((b) => b.transactions)
      .filter((t) => t.type === 'post');
    expect(committed.length, 'the committed ledger holds no post to check').toBeGreaterThan(0);
    // Every post and no amendment — as a set, since the order is asserted
    // separately below and the ledger's own order is by block, not by date.
    expect([...posts.map((t) => t.hash)].sort()).toEqual([...committed.map((t) => t.hash)].sort());
    expect(posts.every((t) => t.type === 'post')).toBe(true);
    // Newest first (§9).
    expect(posts.map((t) => t.date)).toEqual([...posts.map((t) => t.date)].sort().reverse());
  });
});

describe('getStats', () => {
  // Each of these states the *distinction* the tile got wrong once, against
  // the committed ledger: `height` reported the block count for a chain whose
  // tip says one less, and `transactions` reported the post count under a tile
  // labelled Transactions. Written as concrete numbers they described one
  // ledger and went red the day it grew; written as the distinction they hold
  // on any chain and still fail the mutation.
  it('reports the committed height of the tip, not the number of blocks', () => {
    const heights = getChain().blocks.map((b) => b.height);
    expect(heights.length, 'the committed ledger has no block to check').toBeGreaterThan(0);
    expect(getStats().height).toBe(Math.max(...heights));
    expect(getStats().height).toBe(getBlocks()[0]!.height);
    // Heights start at 0, so the tip is always one below the count: a tile
    // reporting `blocks.length` fails here on every chain that exists.
    expect(
      getStats().height,
      'the tile reported how many blocks there are, not the height the tip committed to',
    ).not.toBe(getChain().blocks.length);
  });

  // Amendments are transactions too (§3.9): committed to merkleRoot and
  // counted in txCount. The discriminating version — a post count disagreeing
  // with a transaction count — is on a mocked chain in
  // `tests/site/chain-data-longer-chain.test.ts`. What is real here is that the
  // tile's figure is the headers' own sum and that those headers agree with the
  // transactions they seal.
  it("counts every transaction from the headers' committed txCount", () => {
    const committed = getChain().blocks.reduce((n, b) => n + b.txCount, 0);
    const listed = getChain().blocks.flatMap((b) => b.transactions).length;
    expect(committed, 'the committed ledger holds no transaction to count').toBeGreaterThan(0);
    expect(committed, 'a header commits to a txCount its own block contradicts').toBe(listed);
    expect(getStats().transactions).toBe(committed);
  });

  // A non-empty registry is counted in
  // `tests/site/chain-data-longer-chain.test.ts`; what is real here is that the
  // tile, `getAssets()` and the ledger's own registry are one number, whatever
  // the chain has minted.
  it('counts exactly the tokens the committed registry holds', () => {
    expect(getStats().assets).toBe(getChain().assets.length);
    expect(getAssets()).toHaveLength(getChain().assets.length);
  });

  it('carries no address count of its own', () => {
    // The count lives in `addressIndex()` (src/site/addresses.ts), which also
    // builds the rows on `/address`. It was here, with its own walk over the
    // sealed blocks, and the two pages disagreed — `tests/site/addresses.test.ts`
    // and `tests/site/homepage.test.ts` hold the assertions now. A field
    // restored here would be a second derivation again, and this says so.
    expect(getStats()).not.toHaveProperty('addresses');
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
    // Found by hash rather than by position: `getPosts()` is date-ordered and
    // the ledger is block-ordered, so `[0]` is the same transaction only on a
    // chain with one post.
    expect(getPosts()[0]!.hash).toBe(originalHash);
    expect(
      getChain()
        .blocks.flatMap((b) => b.transactions)
        .some((t) => t.hash === originalHash),
      'the mutation reached the cached ledger',
    ).toBe(true);
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

  /**
   * A recorded open-block post naming the one post that really is on disk.
   *
   * The slug and `contentHash` are the committed ones, so `getPendingBlock`
   * can re-derive the word count from `content/posts/<slug>.md` — the whole
   * point of `derivedGas`. `hash` stays fabricated, because that field IS
   * taken from the record as written (`readPending` is what authenticates it,
   * and it is mocked here).
   */
  const REAL = getPosts()[0]!;
  /** The word count the body on disk actually has — read from the ledger. */
  const REAL_WORDS = REAL.gasUsed;

  function pendingTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      hash: HASH,
      type: 'post',
      slug: REAL.slug,
      title: 'Bài viết',
      date: '2026-08-05',
      tags: ['essay'],
      series: null,
      from: ADDR,
      to: [],
      contentHash: REAL.contentHash,
      assets: [],
      // Deliberately a lie: nothing may print this number.
      gasUsed: 12345,
      value: 2,
      research: null,
      amends: null,
      ...overrides,
    };
  }

  function pendingAmendment(overrides: Partial<Transaction> = {}): Transaction {
    return pendingTx({
      hash: HASH2,
      type: 'amendment',
      slug: null,
      title: 'Bài viết (đã sửa)',
      amends: REAL.hash,
      gasUsed: 0,
      value: 0,
      research: 3,
      ...overrides,
    });
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


  it('returns null when no pending file exists', () => {
    vi.mocked(readPending).mockReturnValue(null);
    expect(getPendingBlock()).toBeNull();
  });

  it('exposes the recorded transactions with their recorded hashes', () => {
    // Not recomputed. The point of the file is that the site shows what
    // chain:build committed, so a hash on the page is one you can diff. HASH
    // is fabricated — if the implementation recomputed it from disk instead of
    // trusting the recorded file, this would not come back matching.
    // (`readPending` is what authenticates that hash, and it is mocked here.)
    const recorded = pendingTx();
    vi.mocked(readPending).mockReturnValue(pendingFixture({ transactions: [recorded] }));

    const pending = getPendingBlock();
    expect(pending).not.toBeNull();
    expect(pending!.transactions[0]!.hash).toBe(HASH);
    expect(pending!.transactions[0]!.contentHash).toBe(REAL.contentHash);
    expect(pending!.transactions[0]!.title).toBe('Bài viết');
  });

  it('re-derives a recorded word count from the body, never trusting the file', () => {
    // §3.8 — gas is derived, and it is in neither canonical form, so a
    // transaction hash cannot vouch for it. A sealed block's is covered by the
    // mined header's committed sum; the open block has no such sum, which let
    // a hand-edited `gasUsed: 12345` print on `/` and `/blocks` through a
    // green build. The body IS committed, as `contentHash`, so the count is
    // taken from there instead.
    vi.mocked(readPending).mockReturnValue(pendingFixture({ transactions: [pendingTx()] }));
    const pending = getPendingBlock()!;
    expect(pending.transactions[0]!.gasUsed).toBe(REAL_WORDS);
    expect(pending.transactions[0]!.gasUsed, 'the file’s claimed word count was believed').not.toBe(12345);
    expect(pending.gasUsed).toBe(REAL_WORDS);
  });

  it('reports no word count at all when it cannot be re-derived', () => {
    // Never a fallback to the recorded number: a figure that could not be
    // re-derived is not one this site may print, on the same rule by which the
    // open block shows no hash it has not mined. The block total goes with it —
    // summing the rest would report a smaller number as the block's gas.
    vi.mocked(readPending).mockReturnValue(
      pendingFixture({ transactions: [pendingTx({ slug: 'khong-co-tren-dia' })] }),
    );
    const pending = getPendingBlock()!;
    expect(pending.transactions[0]!.gasUsed).toBeNull();
    expect(pending.gasUsed).toBeNull();
  });

  it('reports no word count when the body on disk is not the one committed', () => {
    // The slug resolves, but that body hashes to something else, so it is not
    // the text this transaction speaks for.
    vi.mocked(readPending).mockReturnValue(
      pendingFixture({ transactions: [pendingTx({ contentHash: HASH2 })] }),
    );
    expect(getPendingBlock()!.transactions[0]!.gasUsed).toBeNull();
  });

  it("keeps an amendment's gas at the accounting zero §3.9 fixes it at", () => {
    // Not derived: an amendment's gas is 0 by definition so block aggregation
    // cannot re-charge the original's, and `readPending` refuses a recorded
    // amendment that says otherwise.
    vi.mocked(readPending).mockReturnValue(
      pendingFixture({ transactions: [pendingAmendment()] }),
    );
    const pending = getPendingBlock()!;
    expect(pending.transactions[0]!.gasUsed).toBe(0);
    expect(pending.gasUsed).toBe(0);
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
    // Gas is summed over what was *re-derived*, not over what the file claims
    // — both records here claim 12345 and neither contributes it. `value` is
    // summed as recorded, which is sound: a post's declared hours travel in
    // the `post/1` canonical form, so the transaction hash does vouch for them.
    const a = pendingTx({ hash: HASH, value: 1 });
    const b = pendingTx({ hash: HASH2, value: 3 });
    vi.mocked(readPending).mockReturnValue(pendingFixture({ transactions: [a, b] }));

    const pending = getPendingBlock()!;
    expect(pending.txCount).toBe(2);
    expect(pending.gasUsed).toBe(REAL_WORDS * 2);
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
