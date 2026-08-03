import { beforeAll, describe, expect, it, vi } from 'vitest';
import { tagAddress } from '../../src/chain/address';
import { readLock } from '../../src/chain/lock';
import { readPending } from '../../src/chain/pending';
import type { PendingLock } from '../../src/chain/pending';
import type { Block, Chain, Hex, Transaction } from '../../src/chain/types';
import { getAddress, getAddresses } from '../../src/site/addresses';
import { getStats } from '../../src/site/chain-data';

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

/**
 * Two addresses that are on no post's `tags` or `series` and exist nowhere else
 * on this chain. One transaction's `to` names them.
 *
 * `to` is NOT in the `post/1` canonical form (see src/chain/canonical.ts), so
 * no transaction hash covers it: a hand-edited lock can put anything there and
 * `verifyChain` still reports clean. Every view derived from `to` is therefore
 * derived from an unverified field, and these two make that visible — a reader
 * of `to` sees addresses the chain never sent to, and (because every other post
 * here carries `to: []`) misses every address it did.
 */
const PHANTOM = ['0x' + 'f1'.repeat(20), '0x' + 'f2'.repeat(20)];

function post(
  slug: string,
  date: string,
  hash: Hex,
  tags: string[],
  series: string | null,
  value: number,
  to: Hex[] = [],
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
    to,
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
const C = post('bai-c', '2026-07-02', '0x' + 'c3'.repeat(32), ['cp'], 'ghi-chu', 5, PHANTOM);

/**
 * An amendment, per §3.9.
 *
 * Three things about it are load-bearing:
 *
 *  - its `to` is empty and its tag is carried by no post, so "the tag address
 *    graph reflects original publication" — a walk over every transaction
 *    rather than over the posts would mint `dinh-chinh.tag`;
 *  - its `value` is 0 and its declared hours live in `research`, so a view
 *    reading `value` sees the accounting zero, not the figure;
 *  - `research: 20` differs from the 2 that `bai-a` originally declared, which
 *    is what makes "the address total follows the newest record" a statement
 *    with a truth value at all. Equal figures would prove nothing.
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
  research: 20,
  amends: A.hash,
};

/**
 * An amendment still in the open block (§3.6), raising `bai-b` from 3 to 8.
 *
 * §3.9's resolution has to reach into the open block too: everything there is
 * newer than everything sealed, and an amendment recorded this month is already
 * the chain's latest word on the post it amends.
 */
const AMENDMENT_B: Transaction = {
  hash: '0x' + 'bb'.repeat(32),
  type: 'amendment',
  slug: null,
  title: 'bai-b (đã sửa)',
  date: '2026-08-01',
  tags: [],
  series: null,
  from: AUTHOR,
  to: [],
  contentHash: '0x' + '55'.repeat(32),
  assets: [],
  gasUsed: 0,
  value: 0,
  research: 8,
  amends: B.hash,
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
  transactions: [D, AMENDMENT_B],
};

/**
 * What each post's declared hours currently are — the newest amendment's
 * `research`, or the original's `value` where nothing amends it (§3.9).
 *
 * Every figure differs from the raw `value` on the transaction, so an
 * implementation that read `value` straight off the post produces a different
 * number for every address on this chain.
 */
const CURRENT = { A: 20, B: 8, C: 5, D: 7 };

/** Every post's current hours summed — what a *chain-wide* total would be. */
const CHAIN_WIDE = CURRENT.A + CURRENT.B + CURRENT.C + CURRENT.D;

/** §3.8 — what each address actually received, from the posts that sent to it. */
const RECEIVED: Record<string, number> = {
  'cp.tag': CURRENT.A + CURRENT.C + CURRENT.D,
  'meta.tag': CURRENT.A + CURRENT.B,
  'ghi-chu.series': CURRENT.B + CURRENT.C,
  'moi.tag': CURRENT.D,
};

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
    for (const view of await getAddresses()) {
      expect(view.valueReceived, `${view.name} received the wrong total`).toBeCloseTo(
        RECEIVED[view.name]!,
        5,
      );
    }
    // Anti-vacuity: the loop above says nothing if there is nothing to loop.
    expect((await getAddresses()).length).toBe(Object.keys(RECEIVED).length);
  });

  it('is not the chain-wide total value', async () => {
    // §3.8 — the distinction the shipped one-post ledger cannot express. A
    // `valueReceived` that summed the whole chain would agree there and be
    // wrong for every address here.
    const meta = (await getAddress('meta.tag'))!;
    expect(meta.valueReceived).not.toBeCloseTo(CHAIN_WIDE, 5);
    for (const view of await getAddresses()) {
      expect(view.valueReceived, `${view.name} received the whole chain's value`).not.toBeCloseTo(
        CHAIN_WIDE,
        5,
      );
    }
  });
});

describe('value received follows the chain latest record', () => {
  /**
   * §3.9 — a post's current declared hours are the newest amendment's
   * `research`, falling back to the original's `value`. An amendment's own
   * `value` is fixed at 0 so block aggregation cannot re-charge the original's,
   * so a view that read `value` straight off the post shows a figure the chain
   * has moved on from — the same defect the transaction panel carried, at a
   * different surface.
   */
  it('uses the figure a sealed amendment declares, not the one it superseded', async () => {
    const meta = (await getAddress('meta.tag'))!;
    // bai-a declared 2 and was amended to 20; bai-b declared 3 and was amended
    // to 8. Reading `value` off the posts gives 5.
    expect(meta.valueReceived).toBeCloseTo(28, 5);
    expect(meta.valueReceived, 'the address total is still the superseded figure').not.toBeCloseTo(
      A.value + B.value,
      5,
    );
  });

  it('uses the figure an amendment still in the open block declares', async () => {
    // §3.6 — everything in the open block is newer than everything sealed.
    // bai-b's amendment has not sealed; its 8 is still the chain's latest word.
    const series = (await getAddress('ghi-chu.series'))!;
    expect(series.valueReceived).toBeCloseTo(CURRENT.B + CURRENT.C, 5);
    expect(series.valueReceived, "the open block's amendment was ignored").not.toBeCloseTo(
      B.value + C.value,
      5,
    );
  });

  it('replaces the post figure rather than adding to it', async () => {
    // §3.9's whole reason for the zeros: the hours already belong to the
    // transaction the amendment amends. Charging both would inflate the one
    // number §3.8 calls a genuine measure of effort.
    const meta = (await getAddress('meta.tag'))!;
    expect(meta.valueReceived, 'the original and its amendment were both counted').not.toBeCloseTo(
      A.value + AMENDMENT.research! + B.value + AMENDMENT_B.research!,
      5,
    );
  });

  it('leaves an unamended post at its own declared value', async () => {
    // The fallback half. `moi.tag` received only bai-d, which nothing amends.
    const moi = (await getAddress('moi.tag'))!;
    expect(moi.valueReceived).toBeCloseTo(D.value, 5);
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
    expect(cp.valueReceived).toBeCloseTo(RECEIVED['cp.tag']!, 5);
    expect(cp.lastSeen).toBe('2026-08-01');
  });
});

describe('the network address count', () => {
  /**
   * §14 — every displayed field must be a committed one, and the homepage
   * renders this number under an "Addresses" tile.
   *
   * `to` is in no canonical form, so a tampered lock can rewrite it and
   * `verifyChain` still reports clean. This fixture makes the two answers
   * differ: `bai-c` names two addresses in `to` that nothing on this chain ever
   * sent to, and every other post names none at all, so a count taken from `to`
   * is {author} ∪ PHANTOM = 3 — two addresses that do not exist, and not one of
   * the three that do.
   *
   * Derived from `tags` and `series`, which the transaction hash covers, the
   * answer is {author} ∪ {cp, meta, ghi-chu} = 4. A tag and a series share the
   * `tag` domain (§3.7), so slugs count once each.
   */
  it('counts the addresses the committed tags name, not the ones `to` claims', () => {
    expect(getStats().addresses).toBe(4);
    expect(getStats().addresses, 'the count came from the unverified `to` field').not.toBe(
      1 + PHANTOM.length,
    );
  });

  it('counts no address for a tag only an amendment carries', () => {
    // §3.9 — the address graph reflects original publication. Counting the
    // amendment's `dinh-chinh` would make it 5.
    expect(getStats().addresses).toBeLessThan(5);
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
