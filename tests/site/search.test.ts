import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DIST,
  OFF_ORIGIN,
  cssPerPage,
  distPages,
  readDist,
  resolvesIn,
  sameOriginPath,
  scriptClosure,
} from './dist';
import { parseRules, selectorParts } from './css';
import { getBlocks, getPendingBlock, resolvedPosts, shortHash } from '../../src/site/chain-data';
import { addressIndex } from '../../src/site/addresses';
import type { SearchAddress, SearchIndex, SearchPost } from '../../src/site/search-index';
import { fold, searchFor } from '../../src/site/search-query';
import { createSearchBox, type SearchState } from '../../src/site/search-box';
import type { Hex } from '../../src/chain/types';

/**
 * §8/§9 — the search box: the one control in the nav row, and the only thing on
 * this site that fetches a document because a reader asked for it rather than
 * because a page loaded.
 *
 * Three surfaces are checked here, and they are deliberately different kinds of
 * check:
 *
 *  - **`searchFor`**, over a hand-built index, is where the answers live. A
 *    fixture rather than the live corpus, because the questions are "what does
 *    a tag with no address page do" and "what does an ambiguous truncated hash
 *    do" — states the author's chain does not reliably hold, and which
 *    `npm run demo:clear` can take away entirely.
 *  - **`createSearchBox`**, the controller, is where *when* things happen lives:
 *    the index is fetched on first focus and once, arrowing wraps, Enter goes,
 *    Escape dismisses. It is written against an injected loader and an injected
 *    view precisely so this can be asserted without a browser — the DOM adapter
 *    in `Search.astro` is thin, and was driven by hand in a real browser.
 *  - **the build**, for the box's presence on more than one page, its honest
 *    no-JavaScript state, and §9.
 *
 * And one group over the index this repository actually ships, so the fixture
 * above cannot drift from the real document's shape.
 */

/* ------------------------------------------------------------------ *
 * A fixture index
 * ------------------------------------------------------------------ */

/** A 64-hex transaction hash from a two-character seed. */
const txHash = (seed: string): Hex => `0x${seed.repeat(32)}`;
/** A 40-hex address from a two-character seed. */
const addrHash = (seed: string): Hex => `0x${seed.repeat(20)}`;

const POST_A: SearchPost = {
  slug: '2026-03-01-cay-phan-doan',
  title: 'Cây phân đoạn và bài toán truy vấn',
  date: '2026-03-01',
  tags: ['cp', 'cau-truc-du-lieu'],
  series: 'ghi-chu',
  hash: txHash('a1'),
};

const POST_B: SearchPost = {
  slug: '2026-05-20-ham-bam',
  title: 'Hàm băm, từ đầu',
  date: '2026-05-20',
  // `khong-co-dia-chi` deliberately has no entry in `addresses` below: §3.9
  // lets an amendment add a tag to a post after the block that would have
  // registered its address was sealed. Linking a tag straight off a post entry
  // would be a dead link, which this site ships none of.
  tags: ['cp', 'khong-co-dia-chi'],
  series: null,
  hash: txHash('b2'),
  superseded: [txHash('b1')],
};

const ADDRESSES: SearchAddress[] = [
  { name: 'lamter', address: addrHash('c3'), href: '/about' },
  { name: 'cp.tag', address: addrHash('d4'), href: '/address/cp.tag' },
  { name: 'ghi-chu.series', address: addrHash('e5'), href: '/address/ghi-chu.series' },
];

const INDEX: SearchIndex = {
  posts: [POST_B, POST_A],
  addresses: ADDRESSES,
  blocks: [2, 1, 0],
};

const hrefs = (query: string): string[] => searchFor(INDEX, query).hits.map((h) => h.href);
const labels = (query: string): string[] => searchFor(INDEX, query).hits.map((h) => h.label);

/* ------------------------------------------------------------------ *
 * searchFor: what a reader gets back
 * ------------------------------------------------------------------ */

describe('searching by text', () => {
  it('finds a post by a word in its title', () => {
    expect(hrefs('phân đoạn')).toContain(`/tx/${POST_A.slug}`);
    expect(labels('phân đoạn')).toContain(POST_A.title);
  });

  it('finds a post typed without its diacritics', () => {
    // The one accommodation this box makes to how Vietnamese is actually
    // typed. `Hàm băm` is unreachable from a US keyboard without it, and a
    // reader hunting for a post they have already read types what they can.
    expect(hrefs('ham bam')).toContain(`/tx/${POST_B.slug}`);
    expect(hrefs('HAM BAM')).toContain(`/tx/${POST_B.slug}`);
    // …and `đ` decomposes to nothing under NFD, so it needs its own rule.
    expect(fold('Đoạn đường')).toBe('doan duong');
  });

  it('finds a post by its tag and by its series', () => {
    expect(hrefs('cau-truc')).toContain(`/tx/${POST_A.slug}`);
    expect(hrefs('ghi-chu')).toContain(`/tx/${POST_A.slug}`);
  });

  it('offers an address as its own result, from the index that vouches for it', () => {
    const outcome = searchFor(INDEX, 'cp');
    expect(outcome.hits.some((h) => h.kind === 'address' && h.href === '/address/cp.tag')).toBe(true);
  });

  it('never invents a page for a tag that has no address', () => {
    // §3.9 — the finding Task 1 flagged. `khong-co-dia-chi` is on POST_B's tag
    // list and in no address entry, so nothing may link to it. A box that built
    // a tag result out of a post's own `tags` would ship exactly one dead link
    // per amendment-added tag.
    const outcome = searchFor(INDEX, 'khong-co-dia-chi');
    expect(outcome.hits.length, 'the query matched nothing at all, so this proves nothing')
      .toBeGreaterThan(0);
    for (const hit of outcome.hits) {
      expect(hit.href, `${hit.href} is not a page this index vouches for`).not.toContain(
        'khong-co-dia-chi',
      );
    }
  });

  it('only ever offers an href the index itself carries', () => {
    // The general form of the check above, over every query in this file: a
    // post's `/tx/<slug>`, an address's own `href`, or a sealed block.
    const allowed = new Set([
      ...INDEX.posts.map((p) => `/tx/${p.slug}`),
      ...INDEX.addresses.map((a) => a.href),
      ...INDEX.blocks.map((b) => `/block/${b}`),
    ]);
    const queries = ['cp', 'ham', 'ghi-chu', 'khong-co-dia-chi', '0', '1', POST_A.hash, addrHash('d4')];
    let seen = 0;
    for (const query of queries) {
      for (const hit of searchFor(INDEX, query).hits) {
        seen += 1;
        expect(allowed.has(hit.href), `${hit.href} is not in the index`).toBe(true);
      }
    }
    expect(seen, 'no query returned a hit, so nothing was checked').toBeGreaterThan(0);
  });

  it('says nothing at all for an empty query, rather than listing everything', () => {
    expect(searchFor(INDEX, '').hits).toEqual([]);
    expect(searchFor(INDEX, '   ').hits).toEqual([]);
    expect(searchFor(INDEX, '').note).toBeNull();
  });

  it('says so when it finds nothing, and says what it does not cover', () => {
    const outcome = searchFor(INDEX, 'một cụm từ không có ở đâu cả');
    expect(outcome.hits).toEqual([]);
    expect(outcome.note, 'an empty result rendered an empty void').not.toBeNull();
    // The three §8/§3 exclusions a reader would otherwise assume were covered.
    expect(outcome.note!).toMatch(/lời văn|thân bài|nội dung bài/i);
    expect(outcome.note!).toMatch(/nháp/i);
    expect(outcome.note!).toMatch(/contract/i);
  });
});

/* ------------------------------------------------------------------ *
 * searchFor: pasted identifiers (§6)
 * ------------------------------------------------------------------ */

describe('pasting an identifier', () => {
  it('resolves a full transaction hash to its post, and names the post', () => {
    const outcome = searchFor(INDEX, POST_A.hash);
    expect(outcome.hits[0]?.href).toBe(`/tx/${POST_A.slug}`);
    expect(outcome.hits[0]?.kind).toBe('identifier');
    // Not the bare path: a reader who pasted a hash learns which post it is.
    expect(outcome.hits[0]?.label).toBe(POST_A.title);
  });

  it('resolves a superseded hash, upper-cased, with whitespace around it', () => {
    const pasted = `  0X${POST_B.superseded![0]!.slice(2).toUpperCase()}  `;
    expect(searchFor(INDEX, pasted).hits[0]?.href).toBe(`/tx/${POST_B.slug}`);
  });

  it('resolves an address and a sealed block height', () => {
    expect(searchFor(INDEX, addrHash('d4')).hits[0]?.href).toBe('/address/cp.tag');
    expect(searchFor(INDEX, '#1').hits[0]?.href).toBe('/block/1');
    expect(searchFor(INDEX, '1').hits[0]?.href).toBe('/block/1');
  });

  it('resolves the site\'s own truncated spelling of a hash', () => {
    // Every list view on this site prints `shortHash(hash)` — `0xabc123…def456`
    // — and a reader copies what is on screen. `resolveIdentifier` answers null
    // for it, which is correct for an identifier contract and useless to a
    // reader: this is the site's own display format coming back at it.
    const outcome = searchFor(INDEX, shortHash(POST_A.hash));
    expect(outcome.hits[0]?.href).toBe(`/tx/${POST_A.slug}`);
    expect(outcome.hits[0]?.kind).toBe('identifier');
    // Three dots, for a reader whose terminal or editor wrote the ellipsis out.
    expect(searchFor(INDEX, `0x${POST_A.hash.slice(2, 8)}...${POST_A.hash.slice(-6)}`).hits[0]?.href)
      .toBe(`/tx/${POST_A.slug}`);
  });

  it('does not guess when a truncated hash matches more than one record', () => {
    const twins: SearchIndex = {
      ...INDEX,
      posts: [
        { ...POST_A, slug: 'mot', hash: `0x${'ab'.repeat(4)}${'11'.repeat(25)}${'cd'.repeat(3)}` },
        { ...POST_B, slug: 'hai', hash: `0x${'ab'.repeat(4)}${'22'.repeat(25)}${'cd'.repeat(3)}`, superseded: undefined },
      ],
    };
    const outcome = searchFor(twins, '0xabababab…cdcdcd');
    expect(outcome.hits.filter((h) => h.kind === 'identifier')).toEqual([]);
    expect(outcome.note, 'an ambiguous truncation was answered with silence').not.toBeNull();
  });

  it('tells a truncated hash apart from a query that simply found nothing', () => {
    // The distinction Task 1 asked for. Both find no post; only one of them is
    // the reader having pasted something the site itself printed.
    const truncated = searchFor(INDEX, '0xffffff…ffffff').note;
    const nothing = searchFor(INDEX, 'không có gì').note;
    expect(truncated).not.toBeNull();
    expect(truncated).not.toBe(nothing);
    expect(truncated!, 'the note does not tell the reader to paste the full hash').toMatch(/đầy đủ/i);
  });

  it('says a 64-hex hash the chain does not carry is not a post, and why', () => {
    // §6/§8 — a *block* hash is 64 hex too and deliberately does not resolve.
    // Answering "no results" would leave a reader thinking the hash they are
    // looking at is not on the chain at all.
    const note = searchFor(INDEX, txHash('99')).note;
    expect(note, 'an unresolvable 64-hex hash got no explanation').not.toBeNull();
    expect(note!).toMatch(/khối/i);
  });

  it('says a height the chain has not sealed has no page yet', () => {
    const note = searchFor(INDEX, '#404').note;
    expect(note, 'an unsealed height got no explanation').not.toBeNull();
    expect(note!).toContain('404');
    expect(note!, 'the open block is not mentioned').toMatch(/đang mở|chưa được đào|chưa đào/i);
  });

  it('says a half-typed hash is not a whole one', () => {
    const note = searchFor(INDEX, '0xa1a1a1').note;
    expect(note, 'a partial hash got no explanation').not.toBeNull();
    expect(note!).toMatch(/64/);
  });
});

/* ------------------------------------------------------------------ *
 * The controller: when things happen
 * ------------------------------------------------------------------ */

/** A view that records every state it is asked to paint, and every navigation. */
function harness(load: () => Promise<SearchIndex>) {
  const painted: SearchState[] = [];
  const went: string[] = [];
  const box = createSearchBox({
    load,
    view: {
      render: (state) => painted.push(state),
      go: (href) => went.push(href),
    },
  });
  return { box, painted, went, last: () => painted[painted.length - 1] };
}

/** A loader that counts its calls — the whole point of the lazy-fetch group. */
function countingLoader(): { load: () => Promise<SearchIndex>; calls: () => number } {
  let calls = 0;
  return {
    load: () => {
      calls += 1;
      return Promise.resolve(INDEX);
    },
    calls: () => calls,
  };
}

describe('the index is fetched on first focus, once', () => {
  it('fetches nothing when the box is merely on the page', () => {
    // §8 — "lazy-loaded on first focus". A reader who never uses the box pays
    // nothing for it, and every page on this site carries one.
    const { load, calls } = countingLoader();
    harness(load);
    expect(calls(), 'the index was fetched by the box merely existing').toBe(0);
  });

  it('fetches it when the reader focuses the box', () => {
    // The other half, and the one that makes the assertion above mean
    // something: "does not fetch on load" is trivially true of a box that
    // never fetches at all.
    const { load, calls } = countingLoader();
    const { box } = harness(load);
    box.focus();
    expect(calls(), 'focusing the box fetched nothing').toBe(1);
  });

  it('fetches it once, however many times the reader comes back to it', async () => {
    const { load, calls } = countingLoader();
    const { box } = harness(load);
    box.focus();
    await box.ready();
    box.dismiss();
    box.focus();
    box.focus();
    await box.ready();
    expect(calls()).toBe(1);
  });

  it('lets a reader try again after the fetch failed', async () => {
    let calls = 0;
    const load = (): Promise<SearchIndex> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(INDEX);
    };
    const h = harness(load);
    h.box.focus();
    await h.box.ready();
    h.box.input('cp');
    expect(h.last()!.note, 'a failed fetch said nothing').not.toBeNull();
    h.box.focus();
    await h.box.ready();
    expect(calls).toBe(2);
    h.box.input('cp');
    expect(h.last()!.hits.length).toBeGreaterThan(0);
  });

  it('answers a query typed before the document arrived', async () => {
    let settle: (index: SearchIndex) => void = () => {};
    const h = harness(() => new Promise<SearchIndex>((resolve) => (settle = resolve)));
    h.box.focus();
    h.box.input('ham');
    expect(h.last()!.loading, 'the box did not say it was still loading').toBe(true);
    expect(h.last()!.hits).toEqual([]);
    settle(INDEX);
    await h.box.ready();
    expect(h.last()!.hits.map((x) => x.href)).toContain(`/tx/${POST_B.slug}`);
  });
});

describe('the keyboard alone drives the box', () => {
  async function ready() {
    const h = harness(() => Promise.resolve(INDEX));
    h.box.focus();
    await h.box.ready();
    return h;
  }

  it('opens on typing, with the first result already active', async () => {
    const h = await ready();
    h.box.input('cp');
    expect(h.last()!.open).toBe(true);
    expect(h.last()!.hits.length).toBeGreaterThan(1);
    expect(h.last()!.active, 'Enter straight after typing would do nothing').toBe(0);
  });

  it('arrows down and up through the results, wrapping at both ends', async () => {
    const h = await ready();
    h.box.input('cp');
    const n = h.last()!.hits.length;
    expect(n).toBeGreaterThan(1);
    expect(h.box.key('ArrowDown'), 'ArrowDown was left to scroll the page').toBe(true);
    expect(h.last()!.active).toBe(1);
    for (let i = 1; i < n; i++) h.box.key('ArrowDown');
    expect(h.last()!.active, 'arrowing past the last result did not wrap').toBe(0);
    h.box.key('ArrowUp');
    expect(h.last()!.active, 'arrowing up from the first result did not wrap').toBe(n - 1);
  });

  it('opens a closed panel on ArrowDown rather than moving a hidden selection', async () => {
    const h = await ready();
    h.box.input('cp');
    h.box.dismiss();
    expect(h.last()!.open).toBe(false);
    h.box.key('ArrowDown');
    expect(h.last()!.open).toBe(true);
    expect(h.last()!.active).toBe(0);
  });

  it('goes to the active result on Enter', async () => {
    const h = await ready();
    h.box.input('cp');
    h.box.key('ArrowDown');
    const target = h.last()!.hits[1]!.href;
    expect(h.box.key('Enter')).toBe(true);
    expect(h.went).toEqual([target]);
  });

  it('leaves Enter alone when there is nothing to go to', async () => {
    const h = await ready();
    h.box.input('không có gì cả');
    expect(h.box.key('Enter')).toBe(false);
    expect(h.went).toEqual([]);
  });

  it('dismisses on Escape, and clears the query on a second Escape', async () => {
    const h = await ready();
    h.box.input('cp');
    expect(h.box.key('Escape')).toBe(true);
    expect(h.last()!.open).toBe(false);
    expect(h.last()!.query, 'the first Escape threw the query away too').toBe('cp');
    expect(h.box.key('Escape')).toBe(true);
    expect(h.last()!.query).toBe('');
    expect(h.last()!.hits).toEqual([]);
  });

  it('goes where a clicked result points', async () => {
    const h = await ready();
    h.box.input('cp');
    h.box.choose(1);
    expect(h.went).toEqual([h.painted[h.painted.length - 2]!.hits[1]!.href]);
  });

  it('announces what happened, for a reader who cannot see the panel', async () => {
    const h = await ready();
    h.box.input('cp');
    expect(h.last()!.status, 'nothing was announced when results appeared').not.toBe('');
    h.box.input('không có gì cả');
    expect(h.last()!.status, 'an empty result announced nothing').not.toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * The box the build ships
 * ------------------------------------------------------------------ */

/**
 * The search control's own markup on a built page, and nothing around it.
 *
 * Matched by counting `<div>` depth rather than by a lazy regex up to some
 * `</div>`: the first version of this ran `[\s\S]*?<\/div>\s*<\/div>`, which
 * cannot close on this element's shape at all and so silently swallowed most of
 * the page — every assertion below would have been an assertion about the whole
 * document, and the link check that caught it was the only one that noticed.
 */
function boxOf(html: string): string {
  const start = html.indexOf('<div class="search"');
  if (start < 0) throw new Error('the page has no search control');
  let depth = 0;
  for (const tag of html.slice(start).matchAll(/<(\/?)div\b/g)) {
    depth += tag[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, start + tag.index + '</div>'.length);
  }
  throw new Error('the search control is never closed');
}

const PAGES = ['index.html', 'blocks/index.html', 'verify/index.html', '404.html'];

describe('the box in the nav row', () => {
  it('finds the pages it means to check', () => {
    for (const page of PAGES) expect(distPages(), `${page} is not in the build`).toContain(page);
    expect(distPages().length).toBeGreaterThan(4);
  });

  it('is in the nav row of every page in the build', () => {
    // §9 — "identity, section links, search, preferences". Every page, not a
    // sample: the nav is `Base.astro` chrome and a box on the homepage alone
    // would be a box a reader loses the moment they open a post.
    let checked = 0;
    for (const page of distPages()) {
      const nav = /<nav class="nav">[\s\S]*?<\/nav>/.exec(readDist(page));
      expect(nav, `${page} has no nav at all`).not.toBeNull();
      expect(nav![0], `${page}'s nav has no search box`).toContain('id="search-q"');
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1);
  });

  it('sits between the section links and the preferences', () => {
    const nav = /<nav class="nav">[\s\S]*?<\/nav>/.exec(readDist('index.html'))![0];
    expect(nav.indexOf('</ul>')).toBeLessThan(nav.indexOf('id="search-q"'));
    expect(nav.indexOf('id="search-q"')).toBeLessThan(nav.indexOf('class="prefs"'));
  });
});

describe('without JavaScript', () => {
  it('ships the control disabled, not as a live box that does nothing', () => {
    const box = boxOf(readDist('index.html'));
    expect(box, 'the static box is not disabled').toMatch(/<input[^>]*\bdisabled\b/);
  });

  it('says why it is disabled, and where to go instead', () => {
    // The `/verify` pattern: explain, and offer what still works. `<noscript>`
    // rather than a paragraph the script hides, so a reader with JavaScript on
    // never sees the explanation flash through the nav row.
    const box = boxOf(readDist('index.html'));
    const note = /<noscript>([\s\S]*?)<\/noscript>/.exec(box);
    expect(note, 'nothing explains the disabled box').not.toBeNull();
    expect(note![1]!).toMatch(/JavaScript/);
    expect(note![1]!, 'the reader is left with nowhere to go').toContain('href="/tx"');
  });

  it('claims no combobox it cannot open', () => {
    // A `role="combobox"` that never expands is a promise to a screen reader
    // that nothing can keep. The script adds the role along with the behaviour.
    const box = boxOf(readDist('index.html'));
    expect(box).not.toContain('role="combobox"');
    const { code } = scriptClosure('index.html');
    expect(code, 'the script never makes it a combobox either').toContain('combobox');
  });

  it('links only pages this build produced', () => {
    for (const page of distPages()) {
      const box = boxOf(readDist(page));
      for (const m of box.matchAll(/href="(\/[^"]*)"/g)) {
        expect(resolvesIn(DIST, m[1]!), `${m[1]!} is linked from the box and was never built`).toBe(
          true,
        );
      }
    }
  });
});

describe('what the box ships to the browser', () => {
  it('fetches the index and nothing off this origin (§9)', () => {
    const { code } = scriptClosure('index.html');
    expect(code, 'the box does not fetch the index at all').toMatch(
      /fetch\(\s*["'`]\/search-index\.json/,
    );
    let seen = 0;
    for (const m of code.matchAll(/fetch\(\s*(["'`])([^"'`]*)\1/g)) {
      seen += 1;
      expect(sameOriginPath(m[2]!), `the box fetches ${m[2]!}, which is not same-origin`).toBe(true);
    }
    expect(seen, 'no fetch target was found to check').toBeGreaterThan(0);
    expect(code, 'the bundle names an off-origin url').not.toMatch(OFF_ORIGIN);
  });

  it('asks for the index from a focus listener and from nowhere else', () => {
    // The static half of the lazy-fetch guarantee. The controller's own tests
    // prove it fetches once and only after `focus()`; this proves the island
    // actually wires `focus()` to the focus event rather than calling it on
    // load. Confirmed in a real browser too — devtools shows one request for
    // `/search-index.json`, on first focus and not before.
    const source = readFileSync('src/components/Search.astro', 'utf8');
    const script = /<script>([\s\S]*)<\/script>/.exec(source);
    expect(script, 'Search.astro ships no script').not.toBeNull();
    expect(script![1]!).toMatch(/addEventListener\(\s*['"]focus['"]/);
    // Nothing calls the controller's `focus()` outside a listener body.
    for (const m of script![1]!.matchAll(/^\s*box\.focus\(\)/gm)) {
      throw new Error(`Search.astro focuses the box at load time: ${m[0]}`);
    }
  });

  it('carries no Node global and no node: specifier', () => {
    // The index's types live beside `searchIndex()`, which reads the ledger off
    // disk. A value import from that module would drag `node:fs` in here.
    const { code } = scriptClosure('index.html');
    expect(code, 'a node: specifier reached the browser bundle').not.toContain('node:');
    expect(code).not.toMatch(/\bBuffer\b|\bprocess\.env\b/);
    expect(code, 'the ledger reader reached the browser bundle').not.toContain('chain.lock.json');
  });
});

describe('the box under eleven palettes', () => {
  const RULES = ['.search', '.search-input', '.search-panel', '.search-opt'];

  it('uses no hard-coded colour in the search stylesheet', () => {
    const rules = parseRules(readFileSync('src/styles/search.css', 'utf8'));
    expect(rules.length, 'search.css parsed to no rules at all').toBeGreaterThan(0);
    const selectors = new Set(rules.flatMap(selectorParts));
    for (const rule of RULES) {
      expect(
        [...selectors].some((s) => s.split(/[\s>]+/).includes(rule) || s.includes(rule)),
        `${rule} is not a rule in search.css — the guard is not scanning it`,
      ).toBe(true);
    }
    for (const rule of rules) {
      expect(rule.body, `${rule.selector} hard-codes a colour instead of using a token`).not.toMatch(
        /#[0-9a-f]{3,8}\b|rgba?\(/i,
      );
    }
  });

  it('ships those rules to every page, since the box is on every page', () => {
    const css = cssPerPage();
    expect(css.size).toBeGreaterThan(1);
    for (const [page, sheet] of css) {
      for (const rule of RULES) {
        expect(
          parseRules(sheet).some((r) => selectorParts(r).some((p) => p.split(/[\s>]+/).includes(rule))),
          `built css for ${page} has no rule for ${rule}`,
        ).toBe(true);
      }
    }
  });
});

describe('the box is derived, not dated', () => {
  it('reads no clock (§14)', () => {
    for (const file of [
      'src/site/search-query.ts',
      'src/site/search-box.ts',
      'src/components/Search.astro',
    ]) {
      expect(readFileSync(file, 'utf8'), `${file} reads the clock`).not.toMatch(
        /new Date\(\)|Date\.now\(\)/,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * …against the index this repository actually ships
 * ------------------------------------------------------------------ */

describe('over the document the build shipped', () => {
  const shipped = (): SearchIndex => JSON.parse(readDist('search-index.json')) as SearchIndex;

  it('finds every post on the chain by its own title', () => {
    const index = shipped();
    const posts = resolvedPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      const found = searchFor(index, post.title).hits.map((h) => h.href);
      expect(found, `${post.slug} cannot be found by its own title`).toContain(`/tx/${post.slug}`);
    }
  });

  it('resolves every transaction hash, and its truncated spelling, to the same page', () => {
    // The two halves of the same paste: the full hash out of `/chain.json` or a
    // post page, and the `0xabc123…def456` a list view prints. Built from
    // `shortHash` itself, so the box cannot drift from the site's own format.
    const index = shipped();
    let checked = 0;
    for (const post of index.posts) {
      for (const hash of [post.hash, ...(post.superseded ?? [])]) {
        expect(searchFor(index, hash).hits[0]?.href).toBe(`/tx/${post.slug}`);
        expect(
          searchFor(index, shortHash(hash)).hits[0]?.href,
          `${shortHash(hash)} — the site's own spelling — resolves nowhere`,
        ).toBe(`/tx/${post.slug}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('sends every hit it can produce to a page in this build', async () => {
    const index = shipped();
    const queries = [
      ...resolvedPosts().map((p) => p.title),
      ...(await addressIndex()).map((a) => a.name),
      ...getBlocks().map((b) => `#${b.height}`),
      ...index.posts.flatMap((p) => [...p.tags, p.series ?? '']).filter(Boolean),
    ];
    let seen = 0;
    for (const query of queries) {
      for (const hit of searchFor(index, query).hits) {
        seen += 1;
        expect(resolvesIn(DIST, hit.href), `${query} offers ${hit.href}, which was never built`).toBe(
          true,
        );
      }
    }
    expect(seen, 'no query produced a hit at all').toBeGreaterThan(0);
  });

  it('offers no page for the open block, whose height is still a prediction', (ctx) => {
    const open = getPendingBlock();
    if (open === null) ctx.skip('this chain has nothing unsealed');
    const outcome = searchFor(shipped(), `#${open!.height}`);
    expect(outcome.hits.filter((h) => h.kind === 'identifier')).toEqual([]);
    expect(outcome.note, 'the open block got no explanation').not.toBeNull();
  });
});
