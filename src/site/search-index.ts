import { byCodepoint } from '../chain/seal';
import type { Hex } from '../chain/types';
import { addressIndex } from './addresses';
import {
  getBlocks,
  getPendingBlock,
  getPendingPosts,
  getPosts,
  resolvedPosts,
  type RecordedTx,
  type ResolvedPost,
} from './chain-data';

/**
 * §8 — the search index: "a build-time JSON index, lazy-loaded on first focus
 * of the search box. No server and no heavy dependency."
 *
 * **Every byte here is downloaded by a reader who uses the box**, so the
 * question this module answers is not "what could a search box want" but "what
 * is the least that finds a post and resolves a pasted identifier". That is:
 * the posts' own metadata, the hashes that name each post, every address, and
 * the block heights the build produced a page for. Nothing else is in it.
 *
 * **No post bodies.** The corpus is fourteen posts today and will not stay
 * small; a body is thousands of bytes against a post entry's ~200, so bodies
 * would be the payload and everything else a rounding error. What that costs a
 * reader is real and is stated rather than hidden: a phrase that appears only
 * in the prose of a post — a name, a term, a formula — is not findable from the
 * box. Titles, tags and series are. If that proves too thin it is a decision to
 * revisit with evidence about what readers actually searched for, not a guess
 * to make now by shipping a megabyte on the chance it helps.
 *
 * **No `summary` either.** The frontmatter carries an optional one, and it is
 * parsed (`parsePost`) but hashed nowhere — it appears in no canonical form and
 * no transaction hash covers it. Every other value in this document is
 * committed (a title, a tag list, a date, a hash, a height) or re-derived from
 * something committed (an address, from the engine's own digest of the slug it
 * groups on), so admitting one field the chain does not vouch for would put two
 * kinds of value side by side in one document with nothing telling them apart.
 * It is also present on one post in fourteen, which makes it useless as an
 * index anyway.
 *
 * **A post entry carries the state the chain asserts now.** The type says so:
 * every entry is built from a `ResolvedPost` (see the long note on that type in
 * `chain-data.ts`) and a raw ledger entry cannot satisfy it. An index showing an
 * amended post under its superseded title would be the seventh occurrence of
 * one defect on this project. Amendments get no entry of their own (§3.9) —
 * they are ledger entries, not writing, and a reader searching for a post must
 * not get two hits for it — but their hashes do resolve, because a reader can
 * copy one out of a block's transaction table and the page that shows it is the
 * post's.
 *
 * Reads no clock, like everything else under `src/site/` (§14), and every
 * ordering in the document is total and codepoint-based, so two builds of one
 * unchanged chain produce identical bytes on any machine.
 */

/**
 * One post, as the box shows it and resolves to it.
 *
 * Field names are short because they are repeated once per post in a document a
 * reader downloads; they are not abbreviated past the point of being readable
 * in the emitted JSON, which is itself a published document.
 *
 * There is no `href`: it is `/tx/<slug>` for every post on the site, and
 * spending twenty bytes per entry to say so again is exactly the kind of byte
 * this file is meant to refuse.
 */
export interface SearchPost {
  slug: string;
  /** The governing record's title — never the superseded one. */
  title: string;
  /** The committed publication date, `YYYY-MM-DD` (§3.9 keeps it the original's). */
  date: string;
  /** §3.9 — the tags the chain's newest record declares, which is what the post is filed under now. */
  tags: readonly string[];
  series: string | null;
  /**
   * The hash of the record that governs this post: the newest amendment's, or
   * the original's when nothing amends it. The same hash `/tx/<slug>` prints,
   * and the one that commits to the title beside it here.
   */
  hash: Hex;
  /**
   * §3.9 — the other transaction hashes on the chain that name this post: the
   * original's once an amendment supersedes it, plus any older amendments.
   *
   * Present only when there are any, which is the uncommon case; an unamended
   * post is the overwhelming majority and pays nothing for this field.
   *
   * They are here because a reader pastes what they copied. The block table
   * that sealed a post shows the original's hash forever (a block card
   * describes what that block sealed), so the hash most likely to be pasted for
   * an amended post is one that governs nothing — and answering "not found" for
   * a hash the site itself displays would be the box calling the chain a liar.
   */
  superseded?: readonly Hex[];
}

/** §3.7 — one address, and the page it has. */
export interface SearchAddress {
  /** `cp.tag`, `ghi-chu.series`, or the author's name for the identity address. */
  name: string;
  /** `0x` + 40 hex, always the engine's own digest (`src/site/addresses.ts`). */
  address: Hex;
  /** The page this address has — always a route the build produces. */
  href: string;
}

export interface SearchIndex {
  /** Newest first, by committed date, with the slug breaking ties. */
  posts: SearchPost[];
  /** Busiest first — `addressIndex()`'s order, identity first. */
  addresses: SearchAddress[];
  /**
   * §6 — the **sealed** block heights, newest first.
   *
   * The open block is deliberately absent. Its height is a prediction a size
   * split can still change, so `src/pages/block/[height].astro` builds no page
   * for it, and offering a reader who typed that number a link to a route this
   * build never produced is a 404 the index would have invented.
   */
  blocks: number[];
}

/**
 * Newest first (§9 — the chain reads backwards into history), by the post's
 * committed date, with the slug breaking ties in codepoint order.
 *
 * The same rule as the feed's `newestFirst`, and for the same reason:
 * `resolvedPosts()` is the sealed posts in date order followed by the open
 * block's in recorded order, so the halves are merged rather than concatenated,
 * and `byCodepoint` rather than `localeCompare` keeps the order a function of
 * the ledger instead of of the building machine's `LC_ALL`.
 */
function newestFirst(a: ResolvedPost, b: ResolvedPost): number {
  return byCodepoint(b.date, a.date) || byCodepoint(b.slug, a.slug);
}

/**
 * Every transaction on the chain, in chain order: the sealed blocks by
 * ascending height, then the open block's.
 *
 * Ascending rather than `getBlocks()`'s display order, so the hashes collected
 * from it read oldest-first — the order they entered the chain, which is the
 * order the `superseded` list is most legible in.
 */
function chainOrder(): RecordedTx[] {
  const sealed = [...getBlocks()].sort((a, b) => a.height - b.height);
  const open = getPendingBlock();
  return [
    ...sealed.flatMap((b) => b.transactions as RecordedTx[]),
    ...(open === null ? [] : open.transactions),
  ];
}

/**
 * Every transaction hash that names a post, keyed by slug, in chain order.
 *
 * An amendment carries no slug of its own (§3.9); it is filed under the post it
 * amends, exactly as `/tx`'s rows are (`slugFor` in `tx-index.ts`). An `amends`
 * hash naming no post transaction this chain holds contributes nothing — the
 * site resolves only what exists.
 */
function hashesBySlug(): Map<string, Hex[]> {
  const slugOf = new Map<Hex, string>();
  for (const tx of [...getPosts(), ...getPendingPosts()]) {
    if (tx.slug !== null) slugOf.set(tx.hash, tx.slug);
  }

  const out = new Map<string, Hex[]>();
  for (const tx of chainOrder()) {
    const slug = tx.type === 'amendment' ? (tx.amends === null ? undefined : slugOf.get(tx.amends)) : (tx.slug ?? undefined);
    if (slug === undefined) continue;
    const hashes = out.get(slug) ?? [];
    hashes.push(tx.hash);
    out.set(slug, hashes);
  }
  return out;
}

/** §8 — the whole index, derived from the ledger and the recorded open block. */
export async function searchIndex(): Promise<SearchIndex> {
  const hashes = hashesBySlug();

  const posts = [...resolvedPosts()].sort(newestFirst).map((post): SearchPost => {
    // Every record naming this post except the one that governs it. Read from
    // the chain rather than from `originalHash` alone, so a post amended twice
    // resolves from its middle amendment too.
    const superseded = (hashes.get(post.slug) ?? []).filter((hash) => hash !== post.hash);
    // Field order is fixed by this literal, and `JSON.stringify` follows
    // insertion order — which is half of why two builds agree byte for byte.
    const entry: SearchPost = {
      slug: post.slug,
      title: post.title,
      date: post.date,
      tags: [...post.tags],
      series: post.series,
      hash: post.hash,
    };
    return superseded.length === 0 ? entry : { ...entry, superseded };
  });

  const addresses = (await addressIndex()).map(
    (a): SearchAddress => ({ name: a.name, address: a.address, href: a.href }),
  );

  return { posts, addresses, blocks: getBlocks().map((b) => b.height) };
}

/**
 * The document, as the bytes the route serves.
 *
 * Compact — no indentation, no spacing. This is a payload, not a page: nobody
 * diffs it against a committed file the way `/chain.json` is diffed against
 * `chain.lock.json`, and pretty-printing it would add roughly a third again in
 * whitespace to something every reader who opens the box downloads.
 *
 * The trailing newline is one byte and makes the file behave like a file in
 * every tool that reads one.
 */
export async function searchIndexJson(): Promise<string> {
  return `${JSON.stringify(await searchIndex())}\n`;
}

/**
 * §6 — a pasted identifier, resolved to the page that shows it.
 *
 * Defined in `./search-query` and re-exported here, where its contract belongs
 * and where the index's own tests read it from. It moved for one reason: this
 * module imports `chain-data.ts` to build the document, and `chain-data.ts`
 * reads `chain.lock.json` through `node:fs`. The search box runs the very same
 * rule in the reader's browser, and a value import from here would have dragged
 * the ledger reader into the bundle a reader downloads. The rule itself is
 * unchanged, and the function is still the executable form of what this
 * document promises rather than a description the box reimplements.
 */
export { resolveIdentifier } from './search-query';
