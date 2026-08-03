import { describe, expect, it } from 'vitest';
import { tagAddress } from '../../src/chain/address';
import { getAddress, getAddresses } from '../../src/site/addresses';
import { getPosts } from '../../src/site/chain-data';

/**
 * The address views, against the ledger this repository actually ships.
 *
 * The committed chain holds **one** post carrying **one** tag, so several of
 * these are true here by coincidence rather than by behaviour — "newest first"
 * over a single transaction holds for any implementation, and an address that
 * received from the only post on the chain necessarily received the whole
 * chain's value. What discriminates lives in
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
    // An address receives from its own posts alone. On this one-post ledger
    // that happens to equal the chain's whole value; the inequality is proved
    // in addresses-longer-chain.test.ts, where the two genuinely differ.
    const view = (await getAddress('meta.tag'))!;
    const expected = getPosts()
      .filter((t) => t.tags.includes('meta'))
      .reduce((s, t) => s + t.value, 0);
    expect(expected, 'the shipped ledger declares no value to sum').toBeGreaterThan(0);
    expect(view.valueReceived).toBeCloseTo(expected, 5);
  });

  it('reports first and last seen from the committed dates', async () => {
    const view = (await getAddress('meta.tag'))!;
    const dates = getPosts()
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
    const expected = new Set<string>();
    for (const tx of getPosts()) {
      for (const tag of tx.tags) expected.add(`${tag}.tag`);
      if (tx.series !== null) expected.add(`${tx.series}.series`);
    }
    expect(expected.size, 'the shipped ledger has no tags at all').toBeGreaterThan(0);
    expect(new Set((await getAddresses()).map((a) => a.name))).toEqual(expected);
  });
});
