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
import { parseRules, resolveProperty, selectorParts, type StyledElement } from './css';
import { searchDom } from './fake-dom';
import { getBlocks, getPendingBlock, resolvedPosts, shortHash } from '../../src/site/chain-data';
import { addressIndex } from '../../src/site/addresses';
import type { SearchAddress, SearchIndex, SearchPost } from '../../src/site/search-index';
import { fold, searchFor } from '../../src/site/search-query';
import { createSearchBox, type SearchState } from '../../src/site/search-box';
import { attachSearch } from '../../src/site/search-dom';
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
    // Every block card prints `shortHash(block.hash)` too, and no number of
    // extra digits would ever make one resolve — the index carries no block
    // hash at all. A note that only said "paste the whole thing" would send a
    // reader off to fetch 52 more hex digits for nothing.
    expect(truncated!, 'the note never mentions that a block hash cannot resolve here').toMatch(
      /khối/i,
    );
  });

  it('refuses to assert a transaction from two hex digits', () => {
    // Uniqueness on this chain is not evidence. `0x0…f` matched exactly one
    // post out of fourteen and was made the active result, so Enter navigated
    // on two digits; fifteen such one-digit truncations resolved on the live
    // index. The site's own `shortHash` keeps six digits each side, so nothing
    // this site prints is refused by the floor.
    const hash = POST_A.hash;
    const outcome = searchFor(INDEX, `0x${hash.slice(2, 3)}…${hash.slice(-1)}`);
    expect(outcome.hits.filter((h) => h.kind === 'identifier')).toEqual([]);
    expect(outcome.note).not.toBeNull();
    expect(searchFor(INDEX, shortHash(hash)).hits[0]?.kind, 'the floor refuses the site\'s own format')
      .toBe('identifier');
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
    // …and names the tip, rather than explaining the open block. #404 is 402
    // heights past it, and "the open block has no page until it is mined" is a
    // true sentence about something the reader did not ask about.
    expect(note!, 'the note does not say how high the chain actually is').toContain('#2');
    expect(note!, 'a far-off height was explained as the open block').not.toMatch(/đang mở/i);
  });

  it('explains the open block only for the height that is actually the open block', () => {
    // INDEX seals 0, 1, 2 — so #3 is the next one, whose height is a prediction
    // a size split can still change. That is the one case where "not yet" is
    // the whole answer.
    const note = searchFor(INDEX, '#3').note;
    expect(note, 'the next height got no explanation').not.toBeNull();
    expect(note!, 'the open block was not named as such').toMatch(/đang mở/i);
  });

  it('does not hang a block note off a bare number that found posts', () => {
    // `HEIGHT` matches any bare number and a number is also ordinary text.
    // `2026` is every post on this chain by date; printing "the chain has not
    // sealed block #2026" above them is true and irrelevant, in the most
    // prominent line of the panel.
    const outcome = searchFor(INDEX, '2026');
    expect(outcome.hits.length, 'no post matched the year, so this proves nothing')
      .toBeGreaterThan(0);
    expect(outcome.note, 'a year of posts was captioned with a block that does not exist')
      .toBeNull();
    // …but asking for a block, with the `#` a block card prints, still answers.
    expect(searchFor(INDEX, '#2026').note).not.toBeNull();
  });

  it('does not fill the panel with every date that contains one digit', () => {
    // `0` resolves to /block/0 and used to be followed by every post whose
    // date happens to carry a zero — the limit spent on noise, under the one
    // answer the reader asked for.
    const outcome = searchFor(INDEX, '0');
    expect(outcome.hits[0]?.href).toBe('/block/0');
    expect(outcome.hits.map((h) => h.kind).filter((k) => k === 'post')).toEqual([]);
    // A whole year is a query; one digit of one is not.
    expect(searchFor(INDEX, '2026').hits.some((h) => h.kind === 'post')).toBe(true);
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

  it('retries when the reader does the thing the failure note tells them to', async () => {
    // `INDEX_UNREACHABLE` says "bấm lại vào ô này" — click the box again. After
    // a failed load the reader is still focused in it, and clicking an
    // already-focused input fires no `focus` event at all, so the one gesture
    // the note named was the one gesture that could not work. Measured in
    // Chromium before the fix: the fetch count stayed at 1 through the click
    // and only reached 2 after a blur and a refocus.
    let calls = 0;
    const load = (): Promise<SearchIndex> => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(INDEX);
    };
    const h = harness(load);
    h.box.focus();
    await h.box.ready();
    expect(calls).toBe(1);
    h.box.retry();
    expect(calls, 'clicking the box again after a failure did nothing').toBe(2);
    await h.box.ready();
    h.box.input('cp');
    expect(h.last()!.hits.length).toBeGreaterThan(0);
  });

  it('does not re-fetch when the reader clicks a box that already worked', async () => {
    // The other half: `retry` is a repair, not a second load on every click.
    const { load, calls } = countingLoader();
    const h = harness(load);
    h.box.focus();
    await h.box.ready();
    h.box.retry();
    h.box.retry();
    await h.box.ready();
    expect(calls()).toBe(1);
  });

  it('answers a query typed before the document arrived', async () => {
    let settle: (index: SearchIndex) => void = () => {};
    const h = harness(() => new Promise<SearchIndex>((resolve) => (settle = resolve)));
    h.box.focus();
    h.box.input('ham');
    expect(h.last()!.loading, 'the box did not say it was still loading').toBe(true);
    expect(h.last()!.hits).toEqual([]);
    // Shown, not only announced: a panel with no rows and no words is the empty
    // void this box may not render, whatever the reason for it. This used to
    // live in the live region alone, where only a screen reader was told.
    expect(h.last()!.note, 'a sighted reader saw an empty panel while it loaded').not.toBeNull();
    expect(h.last()!.status).not.toBe('');
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
 * The adapter: what actually reaches the document
 * ------------------------------------------------------------------ */

/**
 * `attachSearch` driven against the small DOM in `./fake-dom`.
 *
 * This group exists because of a measured hole. Deleting every `setAttribute`
 * in the adapter — `role="option"`, `aria-selected`, `aria-expanded`,
 * `aria-controls`, `aria-autocomplete`, `aria-activedescendant` — together with
 * the `mousedown` guard that makes a result clickable at all left the suite
 * green at 1024 passing, while the browser showed a stateless combobox nobody
 * could use. The controller tests could not see it (they never touch a
 * document) and the built-output group could not either (it reads markup, and
 * all of this is set at runtime).
 *
 * What this proves: the adapter sets these attributes, keeps them in step with
 * the state, and routes a click on a row's inner `<span>` to the right result.
 * What it cannot prove: that a real browser behaves as `./fake-dom` does. That
 * is checked by hand in Chromium and recorded in the task report — including
 * Chrome's own accessibility tree, which is the only thing that can confirm the
 * attributes add up to a combobox a screen reader can follow.
 */
describe('the adapter wires the document up', () => {
  /** Attached, with the index already loaded and a query typed. */
  async function typed(query: string) {
    const dom = searchDom();
    const went: string[] = [];
    let calls = 0;
    const box = attachSearch(dom.document as unknown as Document, {
      load: () => {
        calls += 1;
        return Promise.resolve(INDEX);
      },
      go: (href) => went.push(href),
    })!;
    dom.field.fire('focus');
    await box.ready();
    if (query !== '') {
      dom.field.value = query;
      dom.field.fire('input');
    }
    return { ...dom, box, went, calls: () => calls };
  }

  it('finds the markup and enables the control', () => {
    const dom = searchDom();
    expect(dom.field.disabled, 'the fixture does not start from the shipped state').toBe(true);
    const box = attachSearch(dom.document as unknown as Document, {
      load: () => Promise.resolve(INDEX),
      go: () => {},
    });
    expect(box, 'attachSearch found none of the markup it expects').not.toBeNull();
    expect(dom.field.disabled).toBe(false);
  });

  it('says nothing at all when the markup is not on the page', () => {
    // Every page carries the box, so this is the "someone renamed an id" case:
    // half-attaching would leave a live combobox over a listbox that is not
    // there.
    const empty = { getElementById: () => null, createElement: () => null };
    expect(attachSearch(empty as unknown as Document, { load: () => Promise.resolve(INDEX), go: () => {} }))
      .toBeNull();
  });

  it('makes the input a combobox, pointed at the listbox', async () => {
    const dom = await typed('');
    expect(dom.field.getAttribute('role')).toBe('combobox');
    expect(dom.field.getAttribute('aria-controls')).toBe('search-list');
    expect(dom.field.getAttribute('aria-autocomplete')).toBe('list');
    expect(dom.field.getAttribute('aria-expanded')).toBe('false');
    // Narrowed from the markup's two ids: `#search-nojs` is a `<noscript>` and
    // is not in this document, so leaving it named would dangle.
    expect(dom.field.getAttribute('aria-describedby')).toBe('search-hint');
  });

  it('fetches the index from the focus event and nowhere else', async () => {
    const dom = searchDom();
    let calls = 0;
    attachSearch(dom.document as unknown as Document, {
      load: () => {
        calls += 1;
        return Promise.resolve(INDEX);
      },
      go: () => {},
    });
    expect(calls, 'attaching the box fetched the index').toBe(0);
    dom.field.fire('focus');
    expect(calls, 'the focus event did not reach the controller').toBe(1);
  });

  it('retries from a click on a box the reader is already focused in', async () => {
    // The DOM half of the same finding: `focus` never fires a second time, so
    // without a `click` listener the instruction in `INDEX_UNREACHABLE` is
    // unfollowable however right the controller is.
    const dom = searchDom();
    let calls = 0;
    const box = attachSearch(dom.document as unknown as Document, {
      load: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(INDEX);
      },
      go: () => {},
    })!;
    dom.field.fire('focus');
    await box.ready();
    expect(calls).toBe(1);
    dom.field.fire('click');
    expect(calls, 'the gesture the failure note names does nothing').toBe(2);
  });

  it('renders each result as an option, with exactly one selected', async () => {
    const dom = await typed('cp');
    expect(dom.list.children.length, 'nothing was rendered to check').toBeGreaterThan(1);
    for (const row of dom.list.children) {
      expect(row.getAttribute('role'), 'a result is not an option').toBe('option');
      expect(row.getAttribute('aria-selected'), 'an option has no selected state').not.toBeNull();
    }
    const selected = dom.list.children.filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected.length, 'a listbox with no or several active options').toBe(1);
    expect(selected[0]).toBe(dom.list.children[0]);
  });

  it('opens the popup and points the input at the active option', async () => {
    const dom = await typed('cp');
    expect(dom.panel.hidden).toBe(false);
    expect(dom.field.getAttribute('aria-expanded')).toBe('true');
    expect(dom.field.getAttribute('aria-activedescendant')).toBe(dom.list.children[0]!.id);
  });

  it('moves the active option, and the pointer to it, on ArrowDown', async () => {
    const dom = await typed('cp');
    const event = dom.field.fire('keydown', { key: 'ArrowDown' });
    expect(event.prevented, 'ArrowDown was left to scroll the page').toBe(1);
    expect(dom.field.getAttribute('aria-activedescendant')).toBe(dom.list.children[1]!.id);
    expect(dom.list.children[1]!.getAttribute('aria-selected')).toBe('true');
    expect(dom.list.children[0]!.getAttribute('aria-selected')).toBe('false');
    expect(dom.list.children[1]!.scrolled, 'the active option was not scrolled into view')
      .toBeGreaterThan(0);
  });

  it('closes on Escape and stops pointing at anything', async () => {
    const dom = await typed('cp');
    dom.field.fire('keydown', { key: 'Escape' });
    expect(dom.panel.hidden).toBe(true);
    expect(dom.field.getAttribute('aria-expanded')).toBe('false');
    expect(
      dom.field.getAttribute('aria-activedescendant'),
      'the input still points at an option in a closed popup',
    ).toBeNull();
  });

  it('goes where a clicked row points, from a click on the text inside it', async () => {
    // A reader clicks a word, not a row: the event target is the inner
    // `<span>`, two levels below the element the handler is bound to.
    const dom = await typed('cp');
    const row = dom.list.children[1]!;
    const label = row.find('search-label');
    expect(label, 'a result row has no label to click').not.toBeNull();
    label!.fire('click');
    expect(dom.went, 'clicking a result went nowhere').toEqual([
      searchFor(INDEX, 'cp').hits[1]!.href,
    ]);
  });

  it('keeps the panel from stealing focus before a click can land', async () => {
    // Without this the default action of pressing inside the panel blurs the
    // input, the box dismisses, and the click lands on nothing. Results are
    // visible and unclickable — which is how it was found.
    const dom = await typed('cp');
    const event = dom.panel.fire('mousedown');
    expect(event.prevented, 'a press inside the panel blurs the input').toBe(1);
  });

  it('closes when focus leaves', async () => {
    const dom = await typed('cp');
    dom.field.fire('blur');
    expect(dom.panel.hidden).toBe(true);
  });

  it('shows and announces a result that is no result', async () => {
    const dom = await typed('không có gì như thế cả');
    expect(dom.list.children).toEqual([]);
    expect(dom.note.hidden, 'an empty result rendered an empty panel').toBe(false);
    expect(dom.note.textContent.length).toBeGreaterThan(20);
    expect(dom.live.textContent, 'nothing was announced').not.toBe('');
  });

  it('writes every string it took off the network as text', async () => {
    // `textContent`, never `innerHTML`: a title comes out of a fetched
    // document. The fake DOM has no `innerHTML` at all, so an adapter that
    // reached for one would fail here rather than ship.
    const dom = await typed('cp');
    const row = dom.list.children[0]!;
    expect(row.find('search-label')!.textContent).toBe(searchFor(INDEX, 'cp').hits[0]!.label);
    expect(row.find('search-detail')!.textContent).toBe(searchFor(INDEX, 'cp').hits[0]!.detail);
  });
});

/* ------------------------------------------------------------------ *
 * The cascade, not the stylesheet
 * ------------------------------------------------------------------ */

/**
 * Where the results list actually sits, and what it wears there.
 *
 * The chain is the point: `#search-list` is inside the panel, inside
 * `.search`, inside `<nav class="nav">`, and it was that last ancestor that
 * relaid it. The nesting is asserted against the built page below, so this
 * fixture cannot go on describing markup the site no longer ships.
 */
const NAV: StyledElement[] = [
  { tag: 'html' },
  { tag: 'body' },
  { tag: 'nav', classes: ['nav'] },
  { tag: 'div', classes: ['search'], attrs: { role: 'search' } },
];
const PANEL: StyledElement = { tag: 'div', id: 'search-panel', classes: ['search-panel'] };
const LIST: StyledElement = {
  tag: 'ul',
  id: 'search-list',
  classes: ['search-list'],
  attrs: { role: 'listbox' },
};
const OPTION: StyledElement = {
  tag: 'li',
  classes: ['search-opt'],
  attrs: { role: 'option', 'aria-selected': 'false', 'data-kind': 'post', 'data-at': '0' },
};

const LIST_CHAIN = [...NAV, PANEL, LIST];
const OPTION_CHAIN = [...LIST_CHAIN, OPTION];

describe('the results read as a list, once the whole cascade is resolved', () => {
  it('is nested where this fixture says it is', () => {
    // Anti-drift: every assertion below is about a chain, and a chain that
    // stopped matching the markup would resolve properties for an element that
    // is not on the page.
    const html = readDist('index.html');
    const nav = /<nav class="nav">[\s\S]*?<\/nav>/.exec(html);
    expect(nav, 'the page has no nav').not.toBeNull();
    const box = boxOf(nav![0]);
    expect(box).toContain('<div class="search-panel" id="search-panel"');
    expect(box).toContain('<ul class="search-list" id="search-list" role="listbox"');
    expect(box.indexOf('id="search-panel"')).toBeLessThan(box.indexOf('id="search-list"'));
  });

  it('lays the results out as a block, not as a row of chips', () => {
    // The defect: `base.css`'s `.nav ul` is (0,1,1) and `.search-list` is
    // (0,1,0), so the nav's own link-list rule won and eight results laid
    // themselves out 3/3/2 across three lines, with ArrowDown moving the
    // highlight sideways. Resolved through the built cascade rather than
    // asserted of a declaration, because every declaration involved was
    // already correct in its own file.
    for (const [page, css] of cssPerPage()) {
      expect(resolveProperty(css, LIST_CHAIN, 'display'), `${page} lays the results out wrong`).toBe(
        'block',
      );
    }
  });

  it('keeps each result a grid row of its own', () => {
    for (const [page, css] of cssPerPage()) {
      expect(resolveProperty(css, OPTION_CHAIN, 'display'), `${page} relays a result row`).toBe(
        'grid',
      );
    }
  });

  it('still resolves the nav\'s own link list as the row it is meant to be', () => {
    // The fix narrowed `.nav ul` to `.nav > ul`, so this is the half that must
    // not have been broken by it: the section links are still a wrapped row.
    // `<nav class="nav"> > <ul>` — the section links, a direct child, which is
    // exactly the element the narrowed selector still has to reach.
    const links: StyledElement[] = [...NAV.slice(0, 3), { tag: 'ul' }];
    for (const [page, css] of cssPerPage()) {
      expect(resolveProperty(css, links, 'display'), `${page} broke the nav's own list`).toBe(
        'flex',
      );
    }
  });

  it('would report the defect it was written for', () => {
    // Anti-vacuity, and the only assertion here allowed to state the old rule:
    // an evaluator that answered "block" whatever it was given would pass every
    // check above. Fed the stylesheet as it was, it must say `flex`.
    const before = '.nav ul { display: flex } .search-list { display: block }';
    expect(resolveProperty(before, LIST_CHAIN, 'display')).toBe('flex');
    // …and the narrowed selector is what changes the answer, on its own.
    const after = '.nav > ul { display: flex } .search-list { display: block }';
    expect(resolveProperty(after, LIST_CHAIN, 'display')).toBe('block');
  });

  it('reads specificity and source order the way a browser does', () => {
    // The evaluator is the instrument; these pin it. An id beats any number of
    // classes, and equal specificity is decided by which rule came last.
    expect(resolveProperty('.a.b.c { display: flex } #search-list { display: grid }', LIST_CHAIN, 'display')).toBe('grid');
    expect(resolveProperty('.search-list { display: flex } .search-list { display: block }', LIST_CHAIN, 'display')).toBe('block');
    expect(resolveProperty('.search-panel > ul { display: flex }', LIST_CHAIN, 'display')).toBe('flex');
    // A child combinator that does not hold must not match.
    expect(resolveProperty('.nav > ul { display: flex }', LIST_CHAIN, 'display')).toBeNull();
    // An attribute selector on the element itself.
    expect(resolveProperty('[role=listbox] { display: flex }', LIST_CHAIN, 'display')).toBe('flex');
  });

  it('refuses a selector it cannot model rather than skipping it', () => {
    // The failure mode this class of evaluator has: quietly ignoring the one
    // rule that decides the answer. A pseudo-class on an element in this chain
    // has to be a loud refusal.
    expect(() => resolveProperty('.search-list:hover { display: flex }', LIST_CHAIN, 'display')).toThrow();
    expect(() => resolveProperty('@media (min-width: 1px) { .search-list { display: flex } }', LIST_CHAIN, 'display')).toThrow();
    // …and something that plainly cannot concern it is skipped, not thrown on,
    // or the built stylesheets could never be resolved at all.
    expect(resolveProperty('.katex .mord:first-child { display: flex }', LIST_CHAIN, 'display')).toBeNull();
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

  it('describes the field with an id that exists whatever runs', () => {
    // Three states, one attribute. With scripting off, `#search-nojs` is the
    // `<noscript>` paragraph. With scripting on it is not in the document, and
    // a lone reference to it dangled — including in the case that matters, an
    // island whose bundle failed, where the field stays disabled with a
    // description pointing at nothing. `#search-hint` is unconditional.
    const box = boxOf(readDist('index.html'));
    const described = /aria-describedby="([^"]*)"/.exec(box);
    expect(described, 'the disabled field is described by nothing').not.toBeNull();
    const ids = described![1]!.split(/\s+/);
    expect(ids).toContain('search-nojs');
    expect(ids, 'no id in the list survives the noscript not being rendered').toContain(
      'search-hint',
    );
    for (const id of ids) {
      expect(box, `aria-describedby names ${id}, which is not in the markup`).toContain(`id="${id}"`);
    }
    // …and the one the script narrows to is outside the `<noscript>`.
    const noscript = /<noscript>[\s\S]*?<\/noscript>/.exec(box)![0];
    expect(noscript).toContain('id="search-nojs"');
    expect(noscript, 'the unconditional description is inside the noscript too').not.toContain(
      'id="search-hint"',
    );
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

  it('does nothing at load but attach, and fetches from the reader\'s focus', () => {
    // The island's script is now three statements: define `load`, and hand it
    // to `attachSearch`. That the fetch happens on focus and once is asserted
    // twice over by execution — by the controller group against a counted
    // loader, and by the adapter group against a fired `focus` event — so what
    // is left for a source scan is only that this file does not reach past
    // them and call anything itself.
    const source = readFileSync('src/components/Search.astro', 'utf8');
    const script = /<script>([\s\S]*)<\/script>/.exec(source);
    expect(script, 'Search.astro ships no script').not.toBeNull();
    expect(script![1]!, 'the island does not attach the box at all').toMatch(/attachSearch\(/);
    expect(script![1]!, 'the island fetches something other than the index').not.toMatch(
      /fetch\((?!\s*'\/search-index\.json')/,
    );
    for (const m of script![1]!.matchAll(/^\s*(load|attachSearch)\(\)/gm)) {
      throw new Error(`Search.astro calls ${m[1]!} at load time`);
    }
    expect(
      readFileSync('src/site/search-dom.ts', 'utf8'),
      'nothing binds the focus event',
    ).toMatch(/addEventListener\(\s*['"]focus['"]/);
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
    // Every module this feature owns, including the two that run during
    // `astro build` rather than in the browser — which is where a clock read
    // would actually make two builds disagree, and which the first version of
    // this guard did not scan at all.
    for (const file of [
      'src/site/search-query.ts',
      'src/site/search-box.ts',
      'src/site/search-dom.ts',
      'src/site/search-index.ts',
      'src/pages/search-index.json.ts',
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
