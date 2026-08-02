import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, internalHrefs, readDist, resolvesIn } from './dist';
import { getBlocks, splitHashWork } from '../../src/site/chain-data';
import { buildSandbox, chainBuildSandbox, sandboxRepo } from './sandbox';

/**
 * `/blocks`, `/block/<height>` and the 404 page.
 *
 * Everything here reads the built `dist/` (or a sandbox's), and every expected
 * value is derived from `chain.lock.json` or from the `chain.pending.json` a
 * real `chain:build` wrote. No literal heights, hashes or counts: a hard-coded
 * one keeps passing after the page stops reading the chain, and starts failing
 * for reasons that have nothing to do with these routes the first time the
 * author publishes.
 */

/**
 * A page's own content, without the chrome `Base.astro` puts on every page.
 *
 * The nav renders `href="/blocks"` on every page in the site, so an assertion
 * that "the 404 page links back to the chain" is satisfied by the nav alone —
 * it would pass with the 404's body deleted entirely. Every link assertion
 * below reads this, not the whole document.
 */
function mainOf(html: string): string {
  const m = /<main[^>]*>([\s\S]*)<\/main>/.exec(html);
  if (m === null) throw new Error('the page has no <main> element');
  return m[1]!;
}

/**
 * Rendered text, with markup removed.
 *
 * A hash on a detail page is emitted as `0x<mark class="zeros">00000</mark>…`,
 * so the committed hash never appears as a contiguous substring of the HTML
 * even when it is rendered in full. What matters for verification is the text
 * a reader can select and paste, which is what this recovers.
 */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** The `<dd>` that follows `<dt>label</dt>`, so a field can be read alone. */
function fieldOf(html: string, label: string): string {
  const m = new RegExp(`<dt>${label}</dt>\\s*<dd>([\\s\\S]*?)</dd>`).exec(html);
  if (m === null) throw new Error(`the page has no <dt>${label}</dt> field`);
  return m[1]!;
}

/**
 * The shared resolver (see `resolvesIn` in ./dist), bound to a sandbox's
 * `dist`. This file used to carry its own copy, without the `isDirectory()`
 * rejection `nav.test.ts:110-127` documents adding — so `href="/tx"`,
 * `/block` or `/blocks` would have counted as resolving here purely because
 * the directory grouping the real pages exists.
 */
const resolvesInSandbox = (root: string, href: string): boolean =>
  resolvesIn(join(root, 'dist'), href);

/** The same resolver, bound to this repo's own already-built `dist`. */
const resolves = (href: string): boolean => resolvesIn(DIST, href);

const listHtml = () => readDist('blocks/index.html');
const blockHtml = (height: number) => readDist(`block/${height}/index.html`);
const notFoundHtml = () => readDist('404.html');

describe('the block list at /blocks', () => {
  it('has blocks to list at all', () => {
    // Anti-vacuity: every per-block loop below asserts nothing on an empty
    // chain, and would report success for a page that rendered no block.
    expect(getBlocks().length).toBeGreaterThan(0);
  });

  it('renders a card for every sealed block', () => {
    for (const block of getBlocks()) {
      expect(listHtml(), `no card for block #${block.height}`).toContain(
        `data-block="${block.height}"`,
      );
    }
  });

  it('orders the blocks newest first', () => {
    const order = [...listHtml().matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toHaveLength(getBlocks().length);
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  it('links each sealed block to its own page', () => {
    const main = mainOf(listHtml());
    for (const block of getBlocks()) {
      expect(main, `block #${block.height} is listed but not linked`).toContain(
        `href="/block/${block.height}"`,
      );
    }
  });

  it('emits no link the build did not produce a page for', () => {
    const hrefs = internalHrefs(mainOf(listHtml()));
    expect(hrefs.length, 'the list emitted no links at all').toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(resolves(href), `${href} is linked from /blocks but was never built`).toBe(true);
    }
  });
});

describe('a sealed block page at /block/<height>', () => {
  it('exists for every sealed block, and names that block', () => {
    for (const block of getBlocks()) {
      const html = blockHtml(block.height);
      // Anchored to the page's own marker: `Block` appears in the nav of
      // every page in the site, and `#0` could come from anywhere.
      expect(html, `/block/${block.height} renders some other block`).toContain(
        `data-block-height="${block.height}"`,
      );
      expect(html).toMatch(new RegExp(`<h1[^>]*>Block #${block.height}</h1>`));
    }
  });

  it('shows the committed header fields of its own block', () => {
    for (const block of getBlocks()) {
      const main = mainOf(blockHtml(block.height));
      expect(fieldOf(main, 'Timestamp')).toContain(block.timestamp);
      expect(textOf(fieldOf(main, 'Txns'))).toContain(String(block.txCount));
      expect(textOf(fieldOf(main, 'Gas used'))).toContain(String(block.gasUsed));
      // The nonce is the mined value; a page without it cannot be checked.
      expect(main).toContain(block.nonce.toLocaleString('en-US'));
    }
  });

  it('lists the transactions that block sealed, and links each to its page', () => {
    for (const block of getBlocks()) {
      const main = mainOf(blockHtml(block.height));
      for (const tx of block.transactions) {
        if (tx.slug === null) continue;
        expect(main, `block #${block.height} does not list ${tx.slug}`).toContain(
          `href="/tx/${tx.slug}"`,
        );
      }
      if (block.transactions.length === 0) {
        expect(main, 'an empty block says nothing about being empty').toContain(
          'Không có bài viết',
        );
      }
    }
  });

  it('emits no link the build did not produce a page for', () => {
    for (const block of getBlocks()) {
      const hrefs = internalHrefs(mainOf(blockHtml(block.height)));
      expect(hrefs.length, `block #${block.height} emitted no links at all`).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(
          resolves(href),
          `${href} is linked from /block/${block.height} but was never built`,
        ).toBe(true);
      }
    }
  });
});

describe('hash display', () => {
  /**
   * §3.2 as amended: truncated where hashes are scanned, full where the page
   * exists to be verified from. Verification has to work with JavaScript off,
   * so the detail page carries the whole hash as text rather than behind a
   * copy control.
   */
  it('shows the full hash on a block detail page and a truncated one in the list', () => {
    const list = textOf(mainOf(listHtml()));
    for (const block of getBlocks()) {
      const detail = textOf(mainOf(blockHtml(block.height)));
      expect(detail, `block #${block.height}'s hash is not shown in full`).toContain(block.hash);
      expect(detail, `block #${block.height}'s merkle root is not shown in full`).toContain(
        block.merkleRoot,
      );
      expect(detail, `block #${block.height}'s detail page truncated its hash`).not.toContain('…');

      expect(list, `block #${block.height}'s full hash appears in the list`).not.toContain(
        block.hash,
      );
      expect(list, `block #${block.height}'s full merkle root appears in the list`).not.toContain(
        block.merkleRoot,
      );
      expect(list, `block #${block.height}'s hash is not truncated in the list`).toContain(
        block.shortHash,
      );
    }
  });

  it("marks the detail page's mined leading zeros, over the whole hash", () => {
    for (const block of getBlocks()) {
      const work = splitHashWork(block.hash, block.difficulty);
      expect(work.zeros.length, `block #${block.height} has difficulty 0`).toBeGreaterThan(0);
      const hash = fieldOf(mainOf(blockHtml(block.height)), 'Hash');
      expect(hash, `block #${block.height}'s proven zeros are not marked`).toContain(
        `<mark class="zeros">${work.zeros}</mark>${work.rest}`,
      );
    }
  });

  it('never marks a merkle root as work, not even an all-zero one', () => {
    // Block 1 is empty and its merkle root is 64 zeros. Highlighting a prefix
    // of it in the accent would dress a computed value up as proof of work
    // that was never done.
    const zeroRoots = getBlocks().filter((b) => /^0x0{10}/.test(b.merkleRoot));
    expect(zeroRoots.length, 'no all-zero merkle root on the chain to check').toBeGreaterThan(0);
    for (const block of getBlocks()) {
      const root = fieldOf(mainOf(blockHtml(block.height)), 'Merkle root');
      expect(root, `block #${block.height}'s merkle root is marked up as mined`).not.toContain(
        '<mark',
      );
    }
  });
});

describe('the 404 page', () => {
  it('links back to the chain from its own body', () => {
    const main = mainOf(notFoundHtml());
    // The prose is author-facing, so it is Vietnamese (unlike explorer chrome).
    expect(main).toContain('Không có gì ở địa chỉ này trên chuỗi');
    const hrefs = internalHrefs(main);
    expect(hrefs, 'the 404 body links nowhere').toContain('/');
    expect(hrefs, 'the 404 body does not link to the chain').toContain('/blocks');
    for (const href of hrefs) {
      expect(resolves(href), `404 links ${href}, which was never built`).toBe(true);
    }
  });

  it('says so in its title', () => {
    expect(notFoundHtml()).toMatch(/<title>404[^<]*<\/title>/);
  });
});

/**
 * The open block. None of this can be read from the project's own `dist/`:
 * the committed chain is entirely sealed and no `chain.pending.json` is (or
 * should be) committed. So a throwaway copy of the repository is driven
 * through a real `chain:build` and a real `astro build`, and its `dist/` read.
 */
const PENDING_SLUG = '2026-08-11-khoi-dang-mo';
const PENDING_TITLE = 'Bài trong khối đang mở';
const PENDING_FILE = [
  '---',
  `title: "${PENDING_TITLE}"`,
  'date: 2026-08-11',
  'tags: [meta]',
  'research: 0.5',
  '---',
  '',
  'Nội dung của bài nằm trong khối chưa niêm phong.',
  '',
].join('\n');

interface PendingRecord {
  period: string;
  height: number;
  transactions: { hash: string; slug: string | null; type: string }[];
}

describe('the open block', () => {
  let dir: string;
  let record: PendingRecord;

  beforeAll(() => {
    dir = sandboxRepo();
    writeFileSync(join(dir, 'content/posts', `${PENDING_SLUG}.md`), PENDING_FILE);
    // The tip is 2026-07 (sealed), so a post dated 2026-08-11 built at a
    // mid-August clock neither seals (the month is not over) nor overflows the
    // block (1 of 4 slots) — it stays pending. Checked, not assumed.
    const chain = chainBuildSandbox(dir, '2026-08-20');
    if (chain.status !== 0) throw new Error(`chain:build failed in the sandbox:\n${chain.output}`);
    record = JSON.parse(readFileSync(join(dir, 'chain.pending.json'), 'utf8')) as PendingRecord;
    if (!record.transactions.some((t) => t.type === 'post' && t.slug === PENDING_SLUG)) {
      throw new Error(`the fixture post did not land in the open block:\n${chain.output}`);
    }
    const build = buildSandbox(dir);
    if (build.status !== 0) throw new Error(`sandbox build failed:\n${build.output}`);
  }, 300_000);

  const sandboxList = () => readFileSync(join(dir, 'dist/blocks/index.html'), 'utf8');

  it('lists every block newest first, including the open one', () => {
    const order = [...sandboxList().matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    // Expected from the chain plus the recorded open block, never written down.
    expect(order).toEqual([record.height, ...getBlocks().map((b) => b.height)]);
    expect(sandboxList()).toContain(`<a href="/tx/${PENDING_SLUG}">${PENDING_TITLE}</a>`);
    expect(sandboxList(), 'the open block is not stamped unsealed').toContain(
      '<span class="stamp open">Chưa niêm phong</span>',
    );
  });

  it('gives the open block no page of its own, and the sealed ones one each', () => {
    // The open block's height is a prediction — a size split could seal a
    // block first and change it. A URL naming a height the chain has not
    // committed to is the same falsehood as a hash it has not mined.
    const page = (height: number) => join(dir, 'dist/block', String(height), 'index.html');
    // Control: the same build does produce pages for the sealed blocks, so
    // this cannot pass because `/block/` was never built at all.
    for (const block of getBlocks()) {
      expect(existsSync(page(block.height)), `no page for sealed block #${block.height}`).toBe(true);
    }
    expect(
      existsSync(page(record.height)),
      `/block/${record.height} names a height the chain has not committed to`,
    ).toBe(false);
    expect(
      mainOf(sandboxList()),
      'the list links the open block to a page that does not exist',
    ).not.toContain(`href="/block/${record.height}"`);
  });

  it('points a pending transaction at /blocks, not at an uncommitted height', () => {
    const html = readFileSync(join(dir, 'dist/tx', PENDING_SLUG, 'index.html'), 'utf8');
    // Anchored to the panel's Block field, since the nav links /blocks on
    // every page in the site.
    expect(fieldOf(mainOf(html), 'Block')).toContain(
      `<a href="/blocks">#${record.height}</a>`,
    );
  });

  it('emits no link the sandbox build did not produce a page for', () => {
    const hrefs = internalHrefs(mainOf(sandboxList()));
    // Anti-vacuity, which this loop was the only one in the file to lack: a
    // `<main>` emitting no links at all would report success having checked
    // nothing — and the open block's card is precisely what this exists to
    // check does not link to a page the build refused to make.
    expect(hrefs.length, 'the sandbox /blocks page emitted no internal links to check').toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(resolvesInSandbox(dir, href), `${href} is linked from /blocks but was never built`).toBe(true);
    }
  });
});
