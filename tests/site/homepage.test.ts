import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { getBlocks, getStats } from '../../src/site/chain-data';
import { meterGeometry } from '../../src/site/meter';

// Read inside each test, never at module level — see tests/site/dist.ts.
const html = () => readDist('index.html');

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
  it('renders every block', () => {
    for (const b of getBlocks()) {
      expect(html(), `missing block #${b.height}`).toContain(`data-block="${b.height}"`);
    }
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

  it('renders each block with all three meter styles', () => {
    const blocks = getBlocks().length;
    expect([...html().matchAll(/meter-m1/g)]).toHaveLength(blocks);
    expect([...html().matchAll(/meter-m2/g)]).toHaveLength(blocks);
    expect([...html().matchAll(/meter-m3/g)]).toHaveLength(blocks);
  });

  it('shows the nonce and the work ratio', () => {
    const newest = getBlocks()[0]!;
    expect(html()).toContain(newest.nonce.toLocaleString('en-US'));
  });

  it('says a silent month is silent, in Vietnamese', () => {
    if (getBlocks().some((b) => b.isEmpty)) {
      expect(html()).toContain('Không có bài viết');
    }
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
    expect(headings().filter((l) => l === 2)).toHaveLength(getBlocks().length);
  });

  it('gives every article an accessible name from a real heading', () => {
    const articles = [...html().matchAll(/<article\b[^>]*>/g)].map((m) => m[0]);
    expect(articles.length).toBe(getBlocks().length);
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
