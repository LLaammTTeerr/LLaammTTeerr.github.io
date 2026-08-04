import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, readDist, resolvesIn } from './dist';
import {
  buildSandbox,
  chainBuildSandbox,
  lockIn,
  sandboxRepo,
  startDevSandbox,
  type DevServer,
} from './sandbox';
import { getBlocks, getPendingBlock, getPostContent, resolvedPosts } from '../../src/site/chain-data';
import { addressIndex } from '../../src/site/addresses';
import { resolveIdentifier, type SearchIndex } from '../../src/site/search-index';
import type { Chain, Transaction } from '../../src/chain/types';

/**
 * §8 — `/search-index.json`, the document the search box lazy-loads.
 *
 * Two rules decide everything asserted here.
 *
 * **An entry is a post, carrying the state the chain asserts *now*.** The index
 * is a post-centric surface, the same kind as `/rss.xml`, `/address/<name>` and
 * `/tx/<slug>`: an amended post appears under its current title beside the hash
 * that commits to it, never the superseded original's. Six surfaces on this
 * project have printed the sealed transaction's fields over an amended post;
 * the assertions below compare every emitted field against `ResolvedPost`, and
 * the sandbox at the bottom does it on a chain that is guaranteed to hold an
 * amendment — the live corpus has one today and `npm run demo:clear` takes it
 * away, so a test that needed it would pass for the wrong reason on a cleared
 * tree.
 *
 * **Amendments are not entries** (§3.9): they are ledger entries, not writing,
 * so a reader searching for a post gets one hit for it and not two.
 *
 * Everything expected is derived from the chain — `resolvedPosts()`,
 * `addressIndex()`, `getBlocks()`, or the sandbox's own mined ledger — and never
 * written out as a literal, because the corpus changes with every post the
 * author publishes.
 */

const INDEX = 'search-index.json';

/** The document the build shipped, parsed. */
function shipped(): SearchIndex {
  return JSON.parse(readDist(INDEX)) as SearchIndex;
}

/**
 * Every string in a parsed document — keys and values, at any depth.
 *
 * The "no bodies" check has to run over these rather than over the emitted
 * bytes: JSON escapes a newline as `\n`, so prose that spans lines is in the
 * text in a spelling no scan for the body itself matches.
 */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      stringsIn(inner, out);
    }
  }
  return out;
}

/** The longest of some candidate strings, trimmed. Never `undefined`. */
function longestOf(parts: string[]): string {
  return parts.map((p) => p.trim()).sort((a, b) => b.length - a.length)[0] ?? '';
}

/** Every transaction on the chain, sealed and open alike. */
function everyTransaction(): Transaction[] {
  const open = getPendingBlock();
  return [
    ...getBlocks().flatMap((b) => b.transactions),
    ...(open === null ? [] : (open.transactions as unknown as Transaction[])),
  ];
}

/** The slug a transaction's page is under: its own, or the post it amends. */
function pageSlugOf(tx: Transaction, all: Transaction[]): string | undefined {
  if (tx.type !== 'amendment') return tx.slug ?? undefined;
  const amended = all.find((t) => t.hash === tx.amends);
  return amended?.slug ?? undefined;
}

/* ------------------------------------------------------------------ *
 * The index this repository ships
 * ------------------------------------------------------------------ */

describe('/search-index.json as the site ships it', () => {
  it('is a file, not a page', () => {
    // `dist/search-index.json/index.html` instead of `dist/search-index.json`
    // would be the silent failure: the route "works" in dev and serves HTML in
    // production, and the box's `fetch` gets a document it cannot parse.
    expect(existsSync(join(DIST, INDEX))).toBe(true);
    expect(readDist(INDEX).startsWith('{')).toBe(true);
  });

  it('has an entry for every post on the chain, and only posts', () => {
    const expected = resolvedPosts().map((p) => p.slug);
    expect(expected.length, 'the chain holds no post to index').toBeGreaterThan(0);
    const slugs = shipped().posts.map((p) => p.slug);
    expect([...slugs].sort()).toEqual([...expected].sort());
    // Each post once. A duplicate entry is what an index built by walking
    // transactions instead of posts produces the moment a post is amended.
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('excludes amendments, per §3.9', () => {
    // Counted against *post* transactions, not against every transaction: on a
    // chain carrying an amendment the two numbers differ, and an index built
    // from the transaction list would carry the larger one.
    const all = everyTransaction();
    const posts = all.filter((t) => t.type === 'post');
    expect(shipped().posts.length).toBe(posts.length);
    for (const entry of shipped().posts) {
      expect(entry.slug, 'an entry carries no slug, so it is not a post').toBeTruthy();
    }
  });

  it('carries each post as the chain describes it now, not as it was sealed', () => {
    // Field by field against `ResolvedPost` — the one resolution — so an
    // implementation that read a raw ledger entry fails here on the demo
    // corpus's amended post. The sandbox below proves the same thing on a chain
    // that is guaranteed to have one.
    const bySlug = new Map(shipped().posts.map((p) => [p.slug, p]));
    expect(bySlug.size).toBeGreaterThan(0);
    for (const post of resolvedPosts()) {
      const entry = bySlug.get(post.slug);
      expect(entry, `${post.slug} is on the chain and not in the index`).toBeDefined();
      expect(entry!.title).toBe(post.title);
      expect(entry!.date).toBe(post.date);
      expect(entry!.tags).toEqual([...post.tags]);
      expect(entry!.series).toBe(post.series);
      // The governing record's hash: the one that commits to the title beside
      // it, which after an amendment is the amendment's.
      expect(entry!.hash).toBe(post.hash);
    }
  });

  it('resolves every transaction hash on the chain to the page that shows it', () => {
    // §6 — "Pasting a full `0x…` transaction hash into the search box resolves
    // to its post." Every transaction, not only the governing ones: an
    // amendment has no page of its own (§3.9) and a reader who copied one out
    // of a block table must land on the post it amends.
    const index = shipped();
    const all = everyTransaction();
    expect(all.length).toBeGreaterThan(0);
    let resolved = 0;
    for (const tx of all) {
      const slug = pageSlugOf(tx, all);
      expect(slug, `${tx.hash} names no page at all`).toBeDefined();
      expect(resolveIdentifier(index, tx.hash), `${tx.hash} resolves nowhere`).toBe(`/tx/${slug!}`);
      resolved += 1;
    }
    expect(resolved).toBe(all.length);
  });

  it('resolves a hash however the reader pasted it', () => {
    // A hash copied out of a terminal, a diff or another explorer arrives
    // upper-cased or with whitespace around it as often as not.
    const index = shipped();
    const post = resolvedPosts()[0];
    expect(post, 'the chain holds no post to paste').toBeDefined();
    const href = `/tx/${post!.slug}`;
    expect(resolveIdentifier(index, post!.hash)).toBe(href);
    expect(resolveIdentifier(index, `  ${post!.hash}  `)).toBe(href);
    expect(resolveIdentifier(index, `0x${post!.hash.slice(2).toUpperCase()}`)).toBe(href);
  });

  it('resolves nothing for a hash that is not on this chain', () => {
    // An index that answered with a page for anything hash-shaped would send a
    // reader to a route the build never produced.
    const absent = `0x${'ab'.repeat(32)}`;
    expect(everyTransaction().some((t) => t.hash === absent)).toBe(false);
    expect(resolveIdentifier(shipped(), absent)).toBeNull();
    expect(resolveIdentifier(shipped(), '')).toBeNull();
    expect(resolveIdentifier(shipped(), 'không phải hash')).toBeNull();
  });

  it('resolves every address on the chain to a page the build produced', async () => {
    const index = shipped();
    const addresses = await addressIndex();
    expect(addresses.length, 'the chain has no address to index').toBeGreaterThan(1);
    for (const entry of addresses) {
      expect(resolveIdentifier(index, entry.address), `${entry.name} resolves nowhere`).toBe(
        entry.href,
      );
      expect(resolvesIn(DIST, entry.href), `${entry.href} is not a page in this build`).toBe(true);
    }
    // The identity address is an address (§3.7) and its page is `/about`, not
    // `/address/<handle>` — a route this site does not build.
    expect(index.addresses.some((a) => a.href === '/about')).toBe(true);
  });

  it('resolves every sealed block height, and no height the chain has not mined', () => {
    const index = shipped();
    const heights = getBlocks().map((b) => b.height);
    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) {
      expect(resolveIdentifier(index, String(height))).toBe(`/block/${height}`);
      expect(resolveIdentifier(index, `#${height}`)).toBe(`/block/${height}`);
      expect(resolvesIn(DIST, `/block/${height}`)).toBe(true);
    }
    // The open block's height is a prediction a size split can still change, so
    // `/block/<height>` is not built for it (see `src/pages/block/[height].astro`)
    // and the box must not offer it.
    const open = getPendingBlock();
    if (open !== null) {
      expect(heights).not.toContain(open.height);
      expect(resolveIdentifier(index, String(open.height))).toBeNull();
    }
    expect(resolveIdentifier(index, String(Math.max(...heights) + 99))).toBeNull();
  });

  it('carries no post body', async () => {
    // §8 — the corpus will not stay small and body text would dominate a
    // payload every reader of the box downloads. What is here instead is the
    // metadata the chain commits to.
    //
    // Searched in the **parsed** document and not in its bytes, which is the
    // difference between a check and a decoration: `JSON.stringify` writes a
    // newline as `\n` and a quote as `\"`, so a prose paragraph — which spans
    // lines — appears in the raw text in a spelling no substring scan for the
    // body will ever match. Measured: with every post's file embedded whole in
    // its entry, a `toContain` over `readDist(INDEX)` stayed green.
    const values = stringsIn(shipped());
    expect(values.length, 'the index carries no strings at all').toBeGreaterThan(0);
    const haystack = values.join('\n');
    let checked = 0;
    for (const post of resolvedPosts()) {
      const { body } = await getPostContent(post.slug);
      // The longest paragraph and the longest single line: the paragraph is the
      // strongest needle, and the line survives any reflowing on the way in.
      for (const needle of [longestOf(body.split(/\n[ \t]*\n/)), longestOf(body.split('\n'))]) {
        expect(needle.length, `${post.slug} has no prose long enough to look for`).toBeGreaterThan(
          40,
        );
        expect(haystack, `${post.slug}'s body is in the index`).not.toContain(needle);
        checked += 1;
      }
    }
    expect(checked, 'no body was checked for').toBeGreaterThan(0);
  });

  it('stays small enough that loading it is not a cost worth thinking about', () => {
    // Not a style preference: this is the whole reason bodies are out. A
    // ceiling with room in it — a single body would blow past it several times
    // over — so this fails when the payload changes kind, not when the author
    // writes a long title.
    const bytes = Buffer.byteLength(readDist(INDEX), 'utf8');
    const posts = resolvedPosts().length;
    expect(posts).toBeGreaterThan(0);
    expect(bytes / posts, `${bytes} bytes over ${posts} posts`).toBeLessThan(512);
  });
});

/* ------------------------------------------------------------------ *
 * A chain mined for the question the live corpus cannot answer
 * ------------------------------------------------------------------ */

/** The fixture post the amendment retitles, and what it was called before. */
const AMENDED_SLUG = '2026-06-15-first';
const ORIGINAL_TITLE = 'Bài viết đầu tiên';
const AMENDED_TITLE = 'Bài viết đầu tiên (viết lại)';

/**
 * A chain this file mines itself, holding the one thing the live corpus cannot
 * be relied on for: **an amendment**. `npm run demo:clear` removes the demo
 * corpus's one amendment and the suite has to be green either way, and a chain
 * with no amendment cannot tell "the current title" from "the original title" —
 * every assertion about the governing state would pass for the wrong reason.
 *
 * The clock is inside July, so June seals and July stays open. The second
 * `chain:build` runs after a retitle of a *sealed* post, which is what produces
 * the amendment (§3.9).
 */
describe('a chain with an amendment', () => {
  let dir = '';
  let json = '';
  let server: DevServer;

  const index = (): SearchIndex => JSON.parse(json) as SearchIndex;

  /** Every transaction the sandbox's own chain holds, sealed and open. */
  const sandboxTransactions = (): Transaction[] => {
    const lock: Chain = lockIn(dir);
    const openPath = join(dir, 'chain.pending.json');
    const open = existsSync(openPath)
      ? (JSON.parse(readFileSync(openPath, 'utf8')) as { transactions: Transaction[] }).transactions
      : [];
    return [...lock.blocks.flatMap((b) => b.transactions), ...open];
  };

  beforeAll(async () => {
    dir = sandboxRepo({ content: 'fixture' });
    const first = chainBuildSandbox(dir, '2026-07-10');
    if (first.status !== 0) throw new Error(`the sandbox chain:build failed:\n${first.output}`);

    const path = join(dir, 'content/posts', `${AMENDED_SLUG}.md`);
    const retitled = readFileSync(path, 'utf8').replace(ORIGINAL_TITLE, AMENDED_TITLE);
    writeFileSync(path, retitled);

    const second = chainBuildSandbox(dir, '2026-07-10');
    if (second.status !== 0) throw new Error(`the amending chain:build failed:\n${second.output}`);

    const built = buildSandbox(dir);
    if (built.status !== 0) throw new Error(`the sandbox build failed:\n${built.output}`);
    json = readFileSync(join(dir, 'dist', INDEX), 'utf8');
    server = await startDevSandbox(dir);
  }, 600_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('mined the chain these assertions need', () => {
    // Anti-vacuity. Without this an amendment that silently stopped being
    // recorded would turn every assertion below into a tautology.
    const all = sandboxTransactions();
    expect(
      all.some((t) => t.type === 'amendment' && t.title === AMENDED_TITLE),
      'the sandbox recorded no amendment, so the title assertions prove nothing',
    ).toBe(true);
    expect(all.some((t) => t.type === 'post' && t.slug === AMENDED_SLUG)).toBe(true);
  });

  it('carries an amended post under its current title', () => {
    const entry = index().posts.find((p) => p.slug === AMENDED_SLUG);
    expect(entry, `no entry for ${AMENDED_SLUG}`).toBeDefined();
    expect(entry!.title).toBe(AMENDED_TITLE);
    // And the superseded title is nowhere in the document: an index that
    // carried both would hand a reader searching for the old wording a result
    // the site shows nowhere.
    expect(json, 'the superseded title is still in the index').not.toContain(ORIGINAL_TITLE + '"');
  });

  it('carries the hash that commits to that title, not the sealed original', () => {
    const all = sandboxTransactions();
    const original = all.find((t) => t.type === 'post' && t.slug === AMENDED_SLUG)!;
    const amendment = all.find((t) => t.type === 'amendment' && t.amends === original.hash)!;
    const entry = index().posts.find((p) => p.slug === AMENDED_SLUG)!;
    expect(entry.hash).toBe(amendment.hash);
    expect(entry.hash, 'the entry carries the superseded transaction').not.toBe(original.hash);
  });

  it('resolves the superseded hash and the amendment alike to the post', () => {
    // Both are on the chain and a reader can copy either out of a block table.
    const all = sandboxTransactions();
    const original = all.find((t) => t.type === 'post' && t.slug === AMENDED_SLUG)!;
    const amendment = all.find((t) => t.type === 'amendment' && t.amends === original.hash)!;
    expect(resolveIdentifier(index(), original.hash)).toBe(`/tx/${AMENDED_SLUG}`);
    expect(resolveIdentifier(index(), amendment.hash)).toBe(`/tx/${AMENDED_SLUG}`);
  });

  it('lists one entry per post and none for the amendment', () => {
    const all = sandboxTransactions();
    const posts = all.filter((t) => t.type === 'post');
    expect(all.length, 'the sandbox chain holds only posts, so §3.9 is untested here')
      .toBeGreaterThan(posts.length);
    expect(index().posts.map((p) => p.slug).sort()).toEqual(posts.map((t) => t.slug!).sort());
  });

  it('points every address it carries at a page this build produced', () => {
    const dist = join(dir, 'dist');
    expect(index().addresses.length).toBeGreaterThan(1);
    for (const address of index().addresses) {
      expect(resolvesIn(dist, address.href), `${address.href} is not a page in this build`).toBe(
        true,
      );
      expect(resolveIdentifier(index(), address.address)).toBe(address.href);
    }
  });

  it('is byte-identical when the same chain is built twice', () => {
    const again = buildSandbox(dir);
    expect(again.status, `the second build failed:\n${again.output}`).toBe(0);
    expect(readFileSync(join(dir, 'dist', INDEX), 'utf8')).toBe(json);
  }, 600_000);

  it('is served over http, as json, byte for byte with the build', async () => {
    // `astro dev` is a second pipeline with its own hooks, and it is the mode
    // the author writes in. A box that fetches this document has to find it
    // there too.
    const response = await server.get(`/${INDEX}`);
    expect(response.status, `dev did not serve /${INDEX}:\n${server.output()}`).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.text()).toBe(json);
  }, 60_000);
});
