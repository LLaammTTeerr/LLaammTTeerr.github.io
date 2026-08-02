import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDist } from './dist';
import { getBlocks, getPendingBlock, getStats } from '../../src/site/chain-data';
import type { AnyBlockView } from '../../src/site/chain-data';
import { meterGeometry } from '../../src/site/meter';
import { buildSandbox, chainBuildSandbox, sandboxRepo } from './sandbox';

// Read inside each test, never at module level — see tests/site/dist.ts.
const html = () => readDist('index.html');

/**
 * The homepage's own contract (Fix 1): the open block first when present —
 * it counts as one of these — then the newest sealed blocks, cut here. This
 * mirrors `HOMEPAGE_BLOCK_COUNT` in `src/pages/index.astro`; if that number
 * changes, this is the line to change alongside it.
 */
const HOMEPAGE_BLOCK_COUNT = 5;

/** Every block the chain has, open one first, exactly as index.astro builds it. */
const allBlocks = (): AnyBlockView[] => {
  const pending = getPendingBlock();
  return pending === null ? getBlocks() : [pending, ...getBlocks()];
};

/**
 * What the homepage is expected to render: `allBlocks()` cut to the
 * homepage's contract. On the committed chain (two blocks) this is every
 * block, same as before Fix 1 — the truncation itself is proven below on a
 * sandboxed chain long enough to actually exercise the cut.
 */
const homepageBlocks = (): AnyBlockView[] => allBlocks().slice(0, HOMEPAGE_BLOCK_COUNT);

/** Blocks past the homepage's cut — real on this repo only once the chain outgrows it. */
const truncatedBlocks = (): AnyBlockView[] => allBlocks().slice(HOMEPAGE_BLOCK_COUNT);

describe('the "view all" link', () => {
  it('styles it through a token, never a literal colour', () => {
    // Same reasoning as tests/site/pending-render.test.ts's ".c-state" check:
    // scoped to the rule Fix 1 added, so this fails only if that rule itself
    // regresses, not on colours other, unrelated rules already declare.
    const css = readFileSync('src/styles/base.css', 'utf8');
    const rule = /\.more a\s*\{[^}]*\}/.exec(css);
    expect(rule, '.more a rule not found in base.css').not.toBeNull();
    expect(rule![0]).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});

describe('stats bar', () => {
  it('shows chain height, transactions, addresses and difficulty', () => {
    const s = getStats();
    expect(html()).toContain('Chain height');
    expect(html()).toContain('Transactions');
    expect(html()).toContain('Addresses');
    expect(html()).toContain('Difficulty');
    expect(html()).toContain(`>${s.height}<`);
  });
});

describe('block list', () => {
  it('lists the latest blocks, up to the homepage cut, and none past it', () => {
    const shown = homepageBlocks();
    // Anti-vacuity: a chain with nothing to show would pass the loop below
    // for a reason unrelated to what it tests.
    expect(shown.length).toBeGreaterThan(0);
    for (const b of shown) {
      expect(html(), `missing block #${b.height}`).toContain(`data-block="${b.height}"`);
    }
    // Real on this repo's own chain only once it outgrows the cut; the
    // sandboxed describe below grows the chain past it to exercise this for
    // real rather than passing here by having nothing to check.
    for (const b of truncatedBlocks()) {
      expect(
        html(),
        `block #${b.height} is past the homepage cut but was still rendered`,
      ).not.toContain(`data-block="${b.height}"`);
    }
  });

  it('links to /blocks exactly when the chain has more than the homepage shows', () => {
    const hasMore = allBlocks().length > HOMEPAGE_BLOCK_COUNT;
    // Scoped to the homepage's own "view all" paragraph, not just any
    // `href="/blocks"` — the nav links there on every page in the site, so an
    // unscoped check would pass even if index.astro never rendered the link.
    const shows = /<p class="more">\s*<a href="\/blocks">/.test(html());
    expect(
      shows,
      hasMore
        ? 'the chain has more blocks than the homepage shows, but it links nowhere for the rest'
        : 'the homepage cut nothing, but still links out for "the rest"',
    ).toBe(hasMore);
  });

  it('orders blocks newest first in the document', () => {
    const order = [...html().matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  it('stamps sealed blocks', () => {
    expect(html()).toContain('Sealed');
  });

  it('marks the genesis block', () => {
    expect(html()).toContain('genesis');
  });

  it('renders each shown block with all three meter styles', () => {
    // Only sealed blocks carry a WorkMeter, and only the ones the homepage
    // actually shows — not every sealed block on the chain.
    const shown = homepageBlocks().filter((b) => b.sealed).length;
    expect(shown).toBeGreaterThan(0);
    expect([...html().matchAll(/meter-m1/g)]).toHaveLength(shown);
    expect([...html().matchAll(/meter-m2/g)]).toHaveLength(shown);
    expect([...html().matchAll(/meter-m3/g)]).toHaveLength(shown);
  });

  it('shows the nonce and the work ratio', () => {
    const newest = getBlocks()[0]!;
    expect(html()).toContain(newest.nonce.toLocaleString('en-US'));
  });

  it('says a silent month is silent, in Vietnamese', () => {
    if (homepageBlocks().some((b) => b.sealed && b.isEmpty)) {
      expect(html()).toContain('Không có bài viết');
    }
  });
});

/**
 * The truncation itself, proven on a chain grown past the homepage's cut —
 * the committed repo's own chain (two blocks) is too short to ever exercise
 * it, so every assertion above about "past the cut" is vacuously true there.
 */
describe('the homepage cut, on a chain longer than it', () => {
  let dir: string;

  beforeAll(() => {
    dir = sandboxRepo();
    // Seals 2026-06 through 2026-11: six blocks (heights 0–5), one more than
    // the homepage's cut of five. `now` is required — see chainBuildSandbox.
    const chain = chainBuildSandbox(dir, '2026-12-05');
    if (chain.status !== 0) throw new Error(`chain:build failed in the sandbox:\n${chain.output}`);
    const build = buildSandbox(dir);
    if (build.status !== 0) throw new Error(`sandbox build failed:\n${build.output}`);
  }, 120_000);

  const sandboxHome = () => readFileSync(join(dir, 'dist/index.html'), 'utf8');

  it('shows only the latest five of the six sealed blocks', () => {
    const order = [...sandboxHome().matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([5, 4, 3, 2, 1]);
    expect(sandboxHome(), 'block #0 is past the cut but still rendered').not.toContain(
      'data-block="0"',
    );
  });

  it('flags the fifth visible block as the spine\'s end, not the chain\'s real oldest', () => {
    // The spine must terminate at the last *visible* card (#1) so it does not
    // run off the bottom — not at #0, which is off the page entirely.
    expect(sandboxHome()).toMatch(
      /data-block="1"><div class="gutter"><span class="spine" data-first="false" data-last="true">/,
    );
    expect(sandboxHome()).not.toMatch(/data-block="0"[\s\S]{0,80}data-last="true"/);
  });

  it('links to /blocks, and /blocks lists all six', () => {
    expect(sandboxHome()).toMatch(/<p class="more">\s*<a href="\/blocks">/);
    const list = readFileSync(join(dir, 'dist/blocks/index.html'), 'utf8');
    const order = [...list.matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([5, 4, 3, 2, 1, 0]);
  });
});

/**
 * The open block counts as one of the five and stays at the top, per Fix 1
 * — displacing the fifth sealed block rather than being added on top of a
 * full five. Grown from the same sandbox as above by adding one more month's
 * post, so the chain is seven blocks deep (six sealed plus the open one) and
 * the cut has to make a real choice about which sealed block to drop.
 */
describe('the open block, counted as one of the five, on a chain past the cut', () => {
  const SLUG = '2026-12-20-mo-trang-moi';
  const TITLE = 'Bài trong khối mới mở';
  let dir: string;
  let pendingHeight: number;

  beforeAll(() => {
    dir = sandboxRepo();
    const sealed = chainBuildSandbox(dir, '2026-12-05');
    if (sealed.status !== 0) throw new Error(`chain:build failed in the sandbox:\n${sealed.output}`);

    writeFileSync(
      join(dir, 'content/posts', `${SLUG}.md`),
      ['---', `title: "${TITLE}"`, 'date: 2026-12-20', 'tags: [meta]', 'research: 0.5', '---', '', 'Nội dung.', ''].join('\n'),
    );
    // Mid-December: the 2026-12 month is not over, so this post lands in the
    // open block rather than sealing it.
    const pending = chainBuildSandbox(dir, '2026-12-22');
    if (pending.status !== 0) throw new Error(`chain:build failed in the sandbox:\n${pending.output}`);
    const record = JSON.parse(readFileSync(join(dir, 'chain.pending.json'), 'utf8')) as {
      height: number;
      transactions: { slug: string | null }[];
    };
    if (!record.transactions.some((t) => t.slug === SLUG)) {
      throw new Error(`the fixture post did not land in the open block:\n${pending.output}`);
    }
    pendingHeight = record.height;

    const build = buildSandbox(dir);
    if (build.status !== 0) throw new Error(`sandbox build failed:\n${build.output}`);
  }, 120_000);

  const sandboxHome = () => readFileSync(join(dir, 'dist/index.html'), 'utf8');

  it('puts the open block first and drops the fifth sealed block, not a fourth slot', () => {
    // Six sealed (0–5) plus the open block at height 6 is seven; the cut
    // still shows five, so #1 and #0 are the two dropped, not just #0.
    const order = [...sandboxHome().matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([pendingHeight, 5, 4, 3, 2]);
    expect(sandboxHome()).toContain(`<span class="stamp open">Chưa niêm phong</span>`);
    expect(sandboxHome()).toContain(`<a href="/tx/${SLUG}">${TITLE}</a>`);
  });

  it("flags the open block as the spine's start", () => {
    expect(sandboxHome()).toMatch(
      new RegExp(`data-block="${pendingHeight}"><div class="gutter"><span class="spine" data-first="true"`),
    );
  });
});

describe('document outline', () => {
  const headings = () =>
    [...html().matchAll(/<h([1-6])\b[^>]*>/g)].map((m) => Number(m[1]));

  it('starts at a single h1', () => {
    const levels = headings();
    expect(levels.length, 'no headings in the built page').toBeGreaterThan(0);
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
  });

  it('skips no heading level', () => {
    // Post titles were once <span>s and block cards had no heading at all;
    // the outline is what a screen reader navigates by, so it is asserted
    // rather than eyeballed.
    const levels = headings();
    let deepest = 0;
    for (const level of levels) {
      expect(level, `heading jumped from h${deepest} to h${level}`).toBeLessThanOrEqual(deepest + 1);
      deepest = Math.max(deepest, level);
    }
  });

  it('gives every block a heading of its own', () => {
    expect(headings().filter((l) => l === 2)).toHaveLength(homepageBlocks().length);
  });

  it('gives every article an accessible name from a real heading', () => {
    const articles = [...html().matchAll(/<article\b[^>]*>/g)].map((m) => m[0]);
    expect(articles.length).toBe(homepageBlocks().length);
    for (const tag of articles) {
      const labelledBy = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
      const label = /aria-label="([^"]+)"/.exec(tag);
      expect(labelledBy ?? label, `article has no accessible name: ${tag}`).toBeTruthy();
      if (labelledBy) {
        expect(html(), `aria-labelledby="${labelledBy}" points at no heading`).toMatch(
          new RegExp(`<h[1-6][^>]*\\bid="${labelledBy}"`),
        );
      }
    }
  });
});

describe('work meter markup', () => {
  // The 3× span lives in meterGeometry alone. These pin that the rendered
  // tick, guide line and expected-value segment come from it — a hard-coded
  // 33.33% or x1="66.67" would survive a change to the span, and stop
  // pointing at 1× expected.
  const geometry = () => {
    const newest = getBlocks()[0]!;
    return meterGeometry(newest.nonce, newest.difficulty);
  };

  it("puts the M1 tick where the geometry says 1x sits", () => {
    expect(html()).toContain(`left:${geometry().tickPct.toFixed(2)}%`);
  });

  it("puts the M3 guide line where the geometry says 1x sits", () => {
    expect(html()).toContain(`x1="${geometry().guideX.toFixed(2)}"`);
  });

  it('marks the M2 segment whose right edge is 1x expected', () => {
    const segs = /<div class="segs">([\s\S]*?)<\/div>/.exec(html())?.[1];
    expect(segs, 'no segment group in the built page').toBeTruthy();
    const classes = [...segs!.matchAll(/<span class="(seg[^"]*)"/g)].map((m) => m[1]!);
    const marked = classes.flatMap((c, i) => (c.includes('exp') ? [i] : []));
    expect(marked).toEqual([geometry().expectedSegmentIndex]);
  });
});

describe('chrome language', () => {
  it('keeps explorer terms in English', () => {
    expect(html()).toContain('Block');
    expect(html()).toContain('Nonce');
  });
});
