import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readLock } from '../../src/chain/lock';
import type { AssetRecord, Block, Chain, Hex, Transaction } from '../../src/chain/types';
import { getPosts, getStats } from '../../src/site/chain-data';

/**
 * The chain-data views, posed against a chain long enough to tell them apart.
 *
 * The committed ledger holds **one** transaction and it is a post, which makes
 * several assertions in `chain-data.test.ts` true by coincidence rather than by
 * behaviour — each of these was proved vacuous by mutation:
 *
 *  - `getPosts › excludes amendments`: `every(t => t.type === 'post')` over a
 *    one-post ledger is vacuously true, and deleting the `.filter` from
 *    `getPosts` left it green.
 *  - `getPosts › returns posts newest first by date`: one post satisfies any
 *    ordering, and deleting the `.sort` left it green.
 *  - `getStats › counts every transaction from the headers' committed
 *    txCount`: one `txCount`, one post, so a post count agrees by accident —
 *    which is the exact mistake the test's own comment warns against, and
 *    counting posts instead left it green.
 *  - `getStats › counts the assets in the committed registry`: `0 === 0` for
 *    any implementation.
 *
 * Those tests still pin the real ledger's concrete numbers, which is worth
 * keeping. The discrimination lives here, on a mocked lock: four transactions
 * across three blocks, of which one is an amendment, with post dates in an
 * order the chain's own does not already produce, and a non-empty registry.
 *
 * Vitest gives each test file its own module registry, so mocking `readLock`
 * here cannot leak into the suites that read the shipped ledger.
 */
vi.mock('../../src/chain/lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chain/lock')>();
  return { ...actual, readLock: vi.fn() };
});

const ADDR = '0x' + 'c'.repeat(40);
const TAG = '0x' + 'd'.repeat(40);
const AMENDMENT_HASH = '0x' + 'ee'.repeat(32);

function post(slug: string, date: string, hash: Hex, value: number): Transaction {
  return {
    hash,
    type: 'post',
    slug,
    title: slug,
    date,
    tags: ['meta'],
    series: null,
    from: ADDR,
    to: [TAG],
    contentHash: '0x' + '11'.repeat(32),
    assets: [],
    gasUsed: 10,
    value,
    research: null,
    amends: null,
  };
}

function block(height: number, period: string, transactions: Transaction[], assets: Hex[] = []): Block {
  const [first] = transactions;
  return {
    height,
    prevHash: '0x' + '00'.repeat(32),
    merkleRoot: '0x' + '00'.repeat(32),
    timestamp: `${period}-01T00:00:00Z`,
    txCount: transactions.length,
    gasUsed: transactions.reduce((n, t) => n + t.gasUsed, 0),
    difficulty: 5,
    nonce: 1,
    hash: '0x' + String(height).repeat(2).padStart(64, '0'),
    period,
    value: transactions.reduce((n, t) => n + t.value, 0),
    transactions: first === undefined ? [] : transactions.map((t, i) => (i === 0 ? { ...t, assets } : t)),
  };
}

/** Chain order deliberately disagrees with date order, so sorting is visible. */
const A = post('bai-a', '2026-06-15', '0x' + '11'.repeat(32), 1);
const B = post('bai-b', '2026-06-28', '0x' + '22'.repeat(32), 2);
const C = post('bai-c', '2026-07-02', '0x' + '33'.repeat(32), 3);

const AMENDMENT: Transaction = {
  hash: AMENDMENT_HASH,
  type: 'amendment',
  slug: null,
  title: 'bai-a (đã sửa)',
  date: '2026-06-15',
  tags: ['meta'],
  series: null,
  from: ADDR,
  to: [],
  contentHash: '0x' + '44'.repeat(32),
  assets: [],
  gasUsed: 0,
  value: 0,
  research: 4,
  amends: A.hash,
};

const ASSETS: AssetRecord[] = [
  { tokenId: 1, hash: '0x' + 'a1'.repeat(32), file: 'one.svg', mime: 'image/svg+xml', bytes: 10, mintedIn: 0 },
  { tokenId: 2, hash: '0x' + 'a2'.repeat(32), file: 'two.svg', mime: 'image/svg+xml', bytes: 20, mintedIn: 0 },
];

beforeAll(() => {
  const chain: Chain = {
    version: 1,
    difficulty: 5,
    blocks: [
      // A before B in chain order, but B is the newer post — so "newest first"
      // is not what array order already gives.
      block(0, '2026-06', [A, B], ASSETS.map((a) => a.hash)),
      block(1, '2026-07', [C, AMENDMENT]),
      block(2, '2026-08', []),
    ],
    assets: ASSETS,
  };
  vi.mocked(readLock).mockReturnValue(chain);
});

describe('getPosts, on a chain that holds an amendment', () => {
  it('excludes the amendment and returns every post', () => {
    const posts = getPosts();
    expect(posts).toHaveLength(3);
    expect(posts.map((t) => t.slug).sort()).toEqual(['bai-a', 'bai-b', 'bai-c']);
    expect(posts.map((t) => t.hash), 'an amendment was returned as a post').not.toContain(
      AMENDMENT_HASH,
    );
  });

  it('returns posts newest first by date, not in the order the chain holds them', () => {
    // Chain order is [bai-a, bai-b, bai-c]; by date it is [bai-c, bai-b,
    // bai-a]. An implementation that skipped the sort would return the first.
    expect(getPosts().map((t) => t.slug)).toEqual(['bai-c', 'bai-b', 'bai-a']);
  });
});

describe('getStats, on a chain whose blocks hold more than posts', () => {
  it("counts every transaction, not every post", () => {
    // §3.9 — amendments are transactions: committed to `merkleRoot`, counted
    // in `txCount`, and shown on the block pages. A post count is 3 here.
    expect(getStats().transactions).toBe(4);
    expect(getStats().transactions).not.toBe(getPosts().length);
  });

  it('counts the assets in the registry', () => {
    expect(getStats().assets).toBe(2);
  });

  it('reports the tip height, not the block count', () => {
    expect(getStats().height).toBe(2);
  });
});
