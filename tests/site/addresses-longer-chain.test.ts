import { beforeAll, describe, expect, it, vi } from 'vitest';
import { tagAddress } from '../../src/chain/address';
import { readLock } from '../../src/chain/lock';
import { readPending } from '../../src/chain/pending';
import type { PendingLock } from '../../src/chain/pending';
import type { Block, Chain, Hex, Transaction } from '../../src/chain/types';
import { getAddress, getAddresses } from '../../src/site/addresses';
import { getPosts } from '../../src/site/chain-data';

/**
 * The address views, posed against a chain long enough to tell them apart.
 *
 * The shipped ledger holds one post carrying one tag, which makes almost every
 * assertion in `addresses.test.ts` true by coincidence: "newest first" holds
 * for any implementation over a single transaction, "only its own posts" holds
 * when there is only one post, and the address that received from the only post
 * on the chain necessarily received the chain's entire value — so the one
 * distinction §3.8 actually draws cannot be stated there at all.
 *
 * This file supplies the discrimination, on a mocked ledger and a mocked open
 * block: five post transactions across three blocks and the mempool, two tags
 * and one series that overlap without coinciding, dates in an order the chain's
 * own does not already produce, and an amendment carrying a tag no post ever
 * sent to.
 *
 * Vitest gives each test file its own module registry, so mocking here cannot
 * leak into the suites that read the shipped ledger.
 */

vi.mock('../../src/chain/lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chain/lock')>();
  return { ...actual, readLock: vi.fn() };
});

// Only `readPending` is mocked: `isStale` stays real, so the fixture open block
// has to be attached to the fixture tip exactly as a recorded one does.
vi.mock('../../src/chain/pending', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chain/pending')>();
  return { ...actual, readPending: vi.fn() };
});

const AUTHOR = '0x' + 'c'.repeat(40);

function post(
  slug: string,
  date: string,
  hash: Hex,
  tags: string[],
  series: string | null,
  value: number,
): Transaction {
  return {
    hash,
    type: 'post',
    slug,
    title: slug,
    date,
    tags,
    series,
    from: AUTHOR,
    // Deliberately empty. `to` is NOT in the `post/1` canonical form (see
    // src/chain/canonical.ts), so no transaction hash covers it — an address
    // view built from `to` would be built from an uncommitted field. Leaving it
    // empty here means such an implementation finds no addresses at all.
    to: [],
    contentHash: '0x' + '11'.repeat(32),
    assets: [],
    gasUsed: 10,
    value,
    research: null,
    amends: null,
  };
}

/** Chain order deliberately disagrees with date order, so sorting is visible. */
const A = post('bai-a', '2026-06-15', '0x' + 'a1'.repeat(32), ['cp', 'meta'], null, 2);
const B = post('bai-b', '2026-06-28', '0x' + 'b2'.repeat(32), ['meta'], 'ghi-chu', 3);
const C = post('bai-c', '2026-07-02', '0x' + 'c3'.repeat(32), ['cp'], 'ghi-chu', 5);

/**
 * §3.9 — "an amendment's `to` stays empty even when tags change, so the tag
 * address graph reflects original publication". Its tag is carried by no post,
 * so an implementation that walked every transaction instead of the posts would
 * mint an address for `dinh-chinh.tag`; its `research: 99` would land in some
 * address's value received.
 */
const AMENDMENT: Transaction = {
  hash: '0x' + 'ee'.repeat(32),
  type: 'amendment',
  slug: null,
  title: 'bai-a (đã sửa)',
  date: '2026-07-09',
  tags: ['dinh-chinh'],
  series: null,
  from: AUTHOR,
  to: [],
  contentHash: '0x' + '44'.repeat(32),
  assets: [],
  gasUsed: 0,
  value: 0,
  research: 99,
  amends: A.hash,
};

/**
 * The open block's post. §3.6 — it is on the chain, just not sealed, so the tag
 * it introduces must have a page immediately. `moi` is carried by nothing
 * sealed, so an implementation reading only `chain.lock.json` produces no
 * `moi.tag` at all, and `cp.tag` misses a transaction it received.
 */
const D = post('bai-d', '2026-08-01', '0x' + 'dd'.repeat(32), ['cp', 'moi'], null, 7);

const TIP: Block = {
  height: 1,
  prevHash: '0x' + '00'.repeat(32),
  merkleRoot: '0x' + '00'.repeat(32),
  timestamp: '2026-07-31T00:00:00Z',
  txCount: 2,
  gasUsed: 10,
  difficulty: 5,
  nonce: 1,
  hash: '0x' + '99'.repeat(32),
  period: '2026-07',
  value: 5,
  transactions: [C, AMENDMENT],
};

const GENESIS: Block = {
  height: 0,
  prevHash: '0x' + '00'.repeat(32),
  merkleRoot: '0x' + '00'.repeat(32),
  timestamp: '2026-06-15T00:00:00Z',
  txCount: 2,
  gasUsed: 20,
  difficulty: 5,
  nonce: 1,
  hash: '0x' + '88'.repeat(32),
  period: '2026-06',
  value: 5,
  transactions: [A, B],
};

const PENDING: PendingLock = {
  version: 1,
  period: '2026-08',
  height: 2,
  prevHash: TIP.hash,
  transactions: [D],
};

/** Every sealed post's declared hours — what a chain-wide total would be. */
const SEALED_VALUE = 2 + 3 + 5;

beforeAll(() => {
  const chain: Chain = {
    version: 1,
    difficulty: 5,
    // Genesis after the tip in array order, so nothing may assume the lock is
    // height-ordered.
    blocks: [TIP, GENESIS],
    assets: [],
  };
  vi.mocked(readLock).mockReturnValue(chain);
  vi.mocked(readPending).mockReturnValue(PENDING);
});

describe('the address graph, on a chain with more than one tag', () => {
  it('groups each post under every tag it carries and nothing more', async () => {
    const meta = (await getAddress('meta.tag'))!;
    expect(meta.transactions.map((t) => t.slug)).toEqual(['bai-b', 'bai-a']);
    // bai-c carries `cp` only. An implementation that put every post under
    // every address would list it here.
    expect(meta.transactions.map((t) => t.slug)).not.toContain('bai-c');
    expect(meta.txCount).toBe(2);
  });

  it('lists an address transactions newest first, not in the order the chain holds them', async () => {
    // Chain order for `cp` is [bai-a (06-15), bai-c (07-02), bai-d (08-01)];
    // by date it is the reverse. Skipping the sort returns the first.
    const cp = (await getAddress('cp.tag'))!;
    expect(cp.transactions.map((t) => t.date)).toEqual(['2026-08-01', '2026-07-02', '2026-06-15']);
  });

  it('derives every address through the engine, for series as well as tags', async () => {
    // §3.7 — a series is an address in the same `tag` domain, under a
    // `.series` name. Both must be the engine's digest, not a local one.
    expect((await getAddress('cp.tag'))!.address).toBe(await tagAddress('cp'));
    expect((await getAddress('ghi-chu.series'))!.address).toBe(await tagAddress('ghi-chu'));
    expect((await getAddress('ghi-chu.series'))!.kind).toBe('series');
    expect((await getAddress('cp.tag'))!.kind).toBe('tag');
  });

  it('gives a series address the posts that named that series', async () => {
    const series = (await getAddress('ghi-chu.series'))!;
    expect(series.transactions.map((t) => t.slug)).toEqual(['bai-c', 'bai-b']);
    expect(series.slug).toBe('ghi-chu');
  });
});

describe('value received is the address own, not the chain', () => {
  it('sums only the posts that sent to it', async () => {
    const meta = (await getAddress('meta.tag'))!;
    // bai-a (2) + bai-b (3). bai-c's 5 and bai-d's 7 went elsewhere.
    expect(meta.valueReceived).toBeCloseTo(5, 5);
  });

  it('is not the chain-wide total value', async () => {
    // §3.8 — the distinction the shipped one-post ledger cannot express. A
    // `valueReceived` that summed the whole chain would agree there and be
    // wrong everywhere else.
    const chainWide = getPosts().reduce((s, t) => s + t.value, 0);
    expect(chainWide).toBeCloseTo(SEALED_VALUE, 5);
    const meta = (await getAddress('meta.tag'))!;
    expect(meta.valueReceived).not.toBeCloseTo(chainWide, 5);
    for (const view of await getAddresses()) {
      expect(view.valueReceived, `${view.name} received the whole chain's value`).toBeLessThan(
        chainWide + 7,
      );
    }
  });

  it('counts an amendment declared hours for no address', async () => {
    // §3.9 — an amendment's hours already belong to the post it amends;
    // charging them again to an address would inflate the one figure §3.8
    // calls a genuine measure of effort.
    const total = (await getAddresses()).reduce((s, a) => s + a.valueReceived, 0);
    expect(total).toBeLessThan(99);
  });
});

describe('the open block counts', () => {
  it('gives a tag first used by an unsealed post a page immediately', async () => {
    const moi = (await getAddress('moi.tag'))!;
    expect(moi, 'a tag introduced by the open block has no address view').toBeDefined();
    expect(moi.transactions.map((t) => t.slug)).toEqual(['bai-d']);
    expect(moi.valueReceived).toBeCloseTo(7, 5);
    expect(moi.address).toBe(await tagAddress('moi'));
  });

  it('adds the unsealed post to an address that already existed', async () => {
    const cp = (await getAddress('cp.tag'))!;
    expect(cp.transactions.map((t) => t.slug)).toContain('bai-d');
    expect(cp.txCount).toBe(3);
    expect(cp.valueReceived).toBeCloseTo(2 + 5 + 7, 5);
    expect(cp.lastSeen).toBe('2026-08-01');
  });
});

describe('what is not an address', () => {
  it('mints no address for a tag only an amendment carries', async () => {
    expect(await getAddress('dinh-chinh.tag')).toBeUndefined();
    expect((await getAddresses()).map((a) => a.name)).not.toContain('dinh-chinh.tag');
  });

  it('puts no amendment in any address transaction list', async () => {
    for (const view of await getAddresses()) {
      expect(
        view.transactions.every((t) => t.type === 'post'),
        `${view.name} lists an amendment as a transaction it received`,
      ).toBe(true);
    }
  });

  it('names exactly the addresses the chain sent to', async () => {
    expect(new Set((await getAddresses()).map((a) => a.name))).toEqual(
      new Set(['cp.tag', 'meta.tag', 'moi.tag', 'ghi-chu.series']),
    );
  });
});

describe('first and last seen', () => {
  it('reads the earliest and latest committed date, not the list ends', async () => {
    const cp = (await getAddress('cp.tag'))!;
    expect(cp.firstSeen).toBe('2026-06-15');
    expect(cp.lastSeen).toBe('2026-08-01');
    const meta = (await getAddress('meta.tag'))!;
    expect(meta.firstSeen).toBe('2026-06-15');
    expect(meta.lastSeen).toBe('2026-06-28');
    // The two addresses genuinely differ, so a view that reported the chain's
    // own span for every address would be visible here.
    expect(cp.lastSeen).not.toBe(meta.lastSeen);
  });
});
