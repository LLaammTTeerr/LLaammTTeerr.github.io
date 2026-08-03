import { describe, expect, it } from 'vitest';
import { tagAddress } from '../../src/chain/address';
import { getAddress, getAddresses } from '../../src/site/addresses';
import {
  getChain,
  getPendingBlock,
  getPendingPosts,
  getPosts,
  type RecordedTx,
} from '../../src/site/chain-data';

/** Every amendment the chain carries, oldest first — the open block's last. */
function amendmentsOldestFirst(): RecordedTx[] {
  const sealed = [...getChain().blocks]
    .sort((a, b) => a.height - b.height)
    .flatMap((b) => b.transactions);
  const open = getPendingBlock()?.transactions ?? [];
  return [...sealed, ...open].filter((t) => t.type === 'amendment');
}

/**
 * The hours the chain currently declares for one post, walked off the raw
 * ledger here rather than taken from `resolvedPosts()`.
 *
 * That is the point: `valueReceived` is summed over the very `ResolvedPost`
 * objects the page renders, so restating it in the site's own terms would
 * compare a number with itself. §3.9's rule — the newest amendment's
 * `research`, falling back to the post's own `value` — is short enough to say
 * twice, and saying it twice is what makes this a check rather than an echo.
 */
function declaredHours(post: RecordedTx, amendments: readonly RecordedTx[]): number {
  let hours = post.value;
  for (const tx of amendments) if (tx.amends === post.hash) hours = tx.research ?? 0;
  return hours;
}

/** Every post on the chain, sealed and unsealed — what an address may receive from. */
function allPosts(): RecordedTx[] {
  return [...getPosts(), ...getPendingPosts()];
}

/**
 * The address views, against the ledger this repository actually ships.
 *
 * On a short chain several of these are true by coincidence rather than by
 * behaviour — "newest first" over a single transaction holds for any
 * implementation, and an address that received from the only post on the chain
 * necessarily received the whole chain's value. What discriminates lives in
 * `tests/site/addresses-longer-chain.test.ts`, on a mocked ledger long enough
 * to tell a correct implementation from an accidental one. These pin the real
 * numbers, which is worth keeping and is what the built pages render.
 *
 * Every expectation is derived from the chain, never written down: a literal
 * `0x33b5…` here would still pass with the derivation removed, which is the
 * one thing the first test exists to prevent.
 */

describe('getAddress, on the shipped ledger', () => {
  it('derives a tag address that matches the engine', async () => {
    // The site must not reimplement address derivation — if these ever
    // disagree, the page shows an address the chain does not know, and it
    // would look completely plausible.
    const view = (await getAddress('meta.tag'))!;
    expect(view, 'no address view for meta.tag').toBeDefined();
    expect(view.address).toBe(await tagAddress('meta'));
  });

  it('lists every post that sent to the address, newest first', async () => {
    const view = (await getAddress('meta.tag'))!;
    const dates = view.transactions.map((t) => t.date);
    expect(dates.length, 'the shipped ledger sent nothing to meta.tag').toBeGreaterThan(0);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(view.transactions.every((t) => t.tags.includes('meta'))).toBe(true);
    expect(view.txCount).toBe(view.transactions.length);
  });

  it('sums only value actually received', async () => {
    // An address receives from its own posts alone. On a one-post ledger that
    // happens to equal the chain's whole value; the inequality is proved in
    // addresses-longer-chain.test.ts, where the two genuinely differ.
    //
    // The per-post figure is the one §3.9 defines — the newest amendment's
    // `research`, or the post's own `value` — walked here off the raw ledger
    // (see `declaredHours`). The previous version compared against raw `value`
    // and pinned "the shipped ledger holds no amendment" as its premise, which
    // is a fact about what happens to be committed rather than about this code.
    const amendments = amendmentsOldestFirst();
    const view = (await getAddress('meta.tag'))!;
    const expected = allPosts()
      .filter((t) => t.tags.includes('meta'))
      .reduce((s, t) => s + declaredHours(t, amendments), 0);
    expect(expected, 'the shipped ledger declares no value to sum').toBeGreaterThan(0);
    expect(view.valueReceived).toBeCloseTo(expected, 5);
  });

  it('reports first and last seen from the committed dates', async () => {
    const view = (await getAddress('meta.tag'))!;
    const dates = allPosts()
      .filter((t) => t.tags.includes('meta'))
      .map((t) => t.date)
      .sort();
    expect(view.firstSeen).toBe(dates[0]);
    expect(view.lastSeen).toBe(dates[dates.length - 1]);
  });

  it('has no page for a name no post ever sent to', async () => {
    // Paired with a positive case on purpose: `getAddress` returning
    // `undefined` for everything would satisfy the negative half alone.
    expect(await getAddress('khong-ton-tai.tag')).toBeUndefined();
    expect(await getAddress('meta.tag')).toBeDefined();
  });
});

describe('getAddresses, on the shipped ledger', () => {
  it('names an address for every tag and series any post sent to, and nothing else', async () => {
    // Sealed and unsealed alike: a tag first used by a post in the open block
    // has an address the moment that post is on the chain (§3.6).
    const expected = new Set<string>();
    for (const tx of allPosts()) {
      for (const tag of tx.tags) expected.add(`${tag}.tag`);
      if (tx.series !== null) expected.add(`${tx.series}.series`);
    }
    expect(expected.size, 'the shipped ledger has no tags at all').toBeGreaterThan(0);
    expect(new Set((await getAddresses()).map((a) => a.name))).toEqual(expected);
  });
});
