import { CHAIN_CONFIG } from '../../chain.config';
import { identityAddress, tagAddress, tagName } from '../chain/address';
import type { Hex } from '../chain/types';
import type { ResolvedPost } from './chain-data';
import { resolvedPosts } from './chain-data';

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
   * `ResolvedPost`, never `Transaction` or `RecordedTx`. The open block's posts
   * are on the chain and belong in this list (§3.6), and an amended post's
   * current title, hash, word count and hours live on its newest amendment
   * (§3.9) — so this list carries what the chain asserts *now*, which is the
   * same thing `valueReceived` below totals. Rows built from the sealed
   * originals under a header built from the current state is exactly the card
   * that contradicted itself.
   */
  transactions: ResolvedPost[];
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

/**
 * §3.7 — a series' name; `tagName` covers the other half.
 *
 * A tag and a series that share a slug therefore share one address under two
 * names, and get two pages showing the same `0x…` with different transaction
 * lists. That is what §3.7 specifies — one `tag` domain for both — and is
 * intended, not a collision to be fixed.
 */
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
 * Ordered by `date` descending with the **original** transaction hash as the
 * tie-break, so two posts sharing a date cannot swap places between builds.
 * `getPosts()` breaks no tie, and appending the open block to it would put
 * unsealed posts after sealed ones whatever their dates say. The tie-break is
 * the original's hash and not the governing one because the governing hash
 * changes on every amendment: keying on it would silently reorder two
 * same-dated posts when the author corrected a typo in one of them.
 *
 * Exported for `src/pages/about.astro`: every post is sent FROM the author's
 * own identity address (§3.7), so this same list — nothing tag- or
 * series-specific about it — is that address's whole transaction history too.
 * Shared rather than re-implemented, so the author page's ordering cannot
 * drift from a tag page's.
 */
export function senders(): ResolvedPost[] {
  return [...resolvedPosts()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.originalHash.localeCompare(b.originalHash),
  );
}

/**
 * The addresses one post sends to: every tag it carries, plus its series.
 *
 * Read from `publishedTags`/`publishedSeries` — the **original** transaction's
 * — and never from `to` or from an amendment. §3.9: "an amendment's `to` stays
 * empty even when tags change, so the tag address graph reflects original
 * publication."
 *
 * Both of those are in the
 * `post/1` canonical form (src/chain/canonical.ts) and so are covered by the
 * transaction hash; `to` is not in it at all, which makes the recorded address
 * list a derived field no hash vouches for. §14: a displayed value is
 * re-derived from something committed, never taken from a recorded-but-
 * unverified number.
 *
 * Deduplicated: a post that named the same tag twice sent to that address once.
 */
function sentTo(post: ResolvedPost): { name: string; slug: string; kind: AddressKind }[] {
  const out = new Map<string, { name: string; slug: string; kind: AddressKind }>();
  for (const slug of post.publishedTags) {
    out.set(tagName(slug), { name: tagName(slug), slug, kind: 'tag' });
  }
  if (post.publishedSeries !== null) {
    const name = seriesName(post.publishedSeries);
    out.set(name, { name, slug: post.publishedSeries, kind: 'series' });
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
  const groups = new Map<string, { slug: string; kind: AddressKind; transactions: ResolvedPost[] }>();
  for (const post of senders()) {
    for (const { name, slug, kind } of sentTo(post)) {
      const group = groups.get(name) ?? { slug, kind, transactions: [] };
      group.transactions.push(post);
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
        //
        // Summed over the very `ResolvedPost` objects the rows on the page are
        // rendered from, so the header total is the sum of its own rows by
        // construction rather than by two derivations agreeing. §3.9 puts a
        // post's current declared hours in its newest amendment's `research`
        // and fixes the amendment's own `value` at 0; both terms are
        // hash-covered — `value` is `research:` in the `post/1` form, and an
        // amendment's `research` is in the `amendment/1` form.
        valueReceived: group.transactions.reduce((sum, p) => sum + p.value, 0),
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

/** A row in the site's address index — and one unit of the homepage's count. */
export interface AddressIndexEntry {
  name: string;
  address: Hex;
  kind: 'identity' | AddressKind;
  /** The page this address has. Always a route the build produces. */
  href: string;
  txCount: number;
  /** §3.8 — hours received (a topic) or declared (the identity). */
  value: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * §3.7 — **every address on this chain, counted once.** The one derivation
 * behind both the homepage's "Addresses" tile and the `/address` index.
 *
 * These were two walks. `getStats()` counted `from` + `tags` + `series` over
 * the sealed blocks; `/address` listed what `getAddresses()` derives, which
 * includes the open block and excludes the author. In a driven sandbox the two
 * pages, both headed *Addresses* and one click apart, read 5 and 4 with nothing
 * on either explaining why. Whichever number was right, two pages answering the
 * same question differently is a failure of the thing this site claims.
 *
 * The identity address is in the count because it is an address (§3.7): every
 * post is sent from it, `/about` is its page and is headed *Identity address*,
 * and an index of "every address" that omitted the busiest one on the chain
 * would be the same understatement in the other direction. It is listed with an
 * `href` of `/about` rather than `/address/<handle>`, which the site does not
 * build — §6 names that route and `src/pages/about.astro` records why it is the
 * same page; linking a route that is not built is what `routes.ts` exists to
 * prevent.
 *
 * The identity address is always present, even on an empty chain: the author
 * exists whether or not anything has been published, and the tile counting 0
 * while `/about` renders a real 40-hex address would be its own contradiction.
 */
export async function addressIndex(): Promise<AddressIndexEntry[]> {
  const posts = senders();
  const dates = posts.map((p) => p.date).sort();
  const topics = await getAddresses();

  const identity: AddressIndexEntry = {
    name: CHAIN_CONFIG.authorName,
    address: await identityAddress(CHAIN_CONFIG.authorHandle),
    kind: 'identity',
    href: '/about',
    txCount: posts.length,
    value: posts.reduce((sum, p) => sum + p.value, 0),
    firstSeen: dates[0] ?? '',
    lastSeen: dates[dates.length - 1] ?? '',
  };

  return [
    identity,
    ...topics.map((a): AddressIndexEntry => ({
      name: a.name,
      address: a.address,
      kind: a.kind,
      href: `/address/${a.name}`,
      txCount: a.txCount,
      value: a.valueReceived,
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
    })),
  ];
}
