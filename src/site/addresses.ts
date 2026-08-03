import { tagAddress, tagName } from '../chain/address';
import type { Hex } from '../chain/types';
import type { RecordedTx } from './chain-data';
import { getPendingPosts, getPosts } from './chain-data';

/**
 * §3.7/§3.8 — the tag and series addresses posts send to, and what each one
 * received.
 *
 * Reads no clock, like everything else under `src/site/` (§14): an address is a
 * function of the ledger plus the recorded open block, so the same chain builds
 * the same pages on any day.
 */

export type AddressKind = 'tag' | 'series';

export interface AddressView {
  /** `cp.tag`, `ghi-chu.series` — the route param and the display name. */
  name: string;
  slug: string;
  kind: AddressKind;
  /** §3.7 — `0x` + 40 hex, always the engine's digest (see `derive`). */
  address: Hex;
  /**
   * The posts that sent here, newest first.
   *
   * `RecordedTx`, not `Transaction`: the open block's posts are on the chain
   * and belong in this list (§3.6), and their `gasUsed` may be `null` because
   * no transaction hash covers a derived field. Anything rendering one has to
   * face that, which is exactly what `txMetaLine` is for.
   */
  transactions: RecordedTx[];
  txCount: number;
  /** §3.8 — declared research hours summed over the posts that sent here. */
  valueReceived: number;
  /** YYYY-MM-DD of the earliest sender, from the committed `date`. */
  firstSeen: string;
  lastSeen: string;
}

/**
 * §3.7 — always the engine's own derivation, never a local copy of it.
 *
 * A tag and a series share the `tag` domain (§3.7: `sha256("addr/1|tag|" +
 * slug)` "for a tag or series"), so this takes the slug and nothing else. The
 * asynchrony comes from `sha256` being WebCrypto's, and is the price of not
 * having a second implementation of the digest in this module: if the site's
 * arithmetic ever diverged from the engine's, the page would show an address
 * the chain does not know, and it would look completely plausible.
 */
function derive(slug: string): Promise<Hex> {
  return tagAddress(slug);
}

/** §3.7 — a series' name; `tagName` covers the other half. */
function seriesName(slug: string): string {
  return `${slug}.series`;
}

/**
 * Every post transaction on the chain, sealed and unsealed, newest first.
 *
 * The open block is included on purpose (§3.6): a tag first used by a post
 * published this month must have a page immediately, because that post is on
 * the chain — just not sealed. Leaving it out would 404 the tag link the post's
 * own page renders.
 *
 * Ordered by `date` descending with the transaction hash as the tie-break, so
 * two posts sharing a date cannot swap places between builds. `getPosts()`
 * breaks no tie, and appending the open block to it would put unsealed posts
 * after sealed ones whatever their dates say.
 */
function senders(): RecordedTx[] {
  return [...getPosts(), ...getPendingPosts()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.hash.localeCompare(b.hash),
  );
}

/**
 * The addresses one post sends to: every tag it carries, plus its series.
 *
 * Read from `tags` and `series`, never from `to`. Both of those are in the
 * `post/1` canonical form (src/chain/canonical.ts) and so are covered by the
 * transaction hash; `to` is not in it at all, which makes the recorded address
 * list a derived field no hash vouches for. §14: a displayed value is
 * re-derived from something committed, never taken from a recorded-but-
 * unverified number.
 *
 * Deduplicated: a post that named the same tag twice sent to that address once.
 */
function sentTo(tx: RecordedTx): { name: string; slug: string; kind: AddressKind }[] {
  const out = new Map<string, { name: string; slug: string; kind: AddressKind }>();
  for (const slug of tx.tags) out.set(tagName(slug), { name: tagName(slug), slug, kind: 'tag' });
  if (tx.series !== null) {
    const name = seriesName(tx.series);
    out.set(name, { name, slug: tx.series, kind: 'series' });
  }
  return [...out.values()];
}

/**
 * §3.7 — every address on the chain, most-received-from first.
 *
 * Amendments never appear: `senders()` is post transactions only, and §3.9 is
 * explicit that "an amendment's `to` stays empty even when tags change, so the
 * tag address graph reflects original publication". An amendment that renamed a
 * tag would otherwise mint an address no post ever sent to, and its declared
 * `research` — which already belongs to the post it amends — would be charged
 * to that address as value received.
 *
 * The order is a total one (`txCount` desc, then name) so the index page and
 * the generated routes are the same on every build.
 */
export async function getAddresses(): Promise<AddressView[]> {
  const groups = new Map<string, { slug: string; kind: AddressKind; transactions: RecordedTx[] }>();
  for (const tx of senders()) {
    for (const { name, slug, kind } of sentTo(tx)) {
      const group = groups.get(name) ?? { slug, kind, transactions: [] };
      group.transactions.push(tx);
      groups.set(name, group);
    }
  }

  const views = await Promise.all(
    [...groups].map(async ([name, group]): Promise<AddressView> => {
      const dates = group.transactions.map((t) => t.date).sort();
      return {
        name,
        slug: group.slug,
        kind: group.kind,
        address: await derive(group.slug),
        transactions: group.transactions,
        txCount: group.transactions.length,
        // §3.8 — this address's own value, summed over what it received. The
        // chain's total is a different number and means a different thing.
        // Each `value` is the declared hours in the post's own canonical form,
        // so every term here is hash-covered.
        valueReceived: group.transactions.reduce((sum, t) => sum + t.value, 0),
        // Min and max of the committed dates rather than the ends of the list,
        // so this stays true however the list is ordered.
        firstSeen: dates[0] ?? '',
        lastSeen: dates[dates.length - 1] ?? '',
      };
    }),
  );

  return views.sort((a, b) => b.txCount - a.txCount || a.name.localeCompare(b.name));
}

/** One address by name, or `undefined` when no post ever sent to that name. */
export async function getAddress(name: string): Promise<AddressView | undefined> {
  return (await getAddresses()).find((a) => a.name === name);
}
