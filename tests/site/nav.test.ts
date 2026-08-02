import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, distPages, readDist } from './dist';

/**
 * Fix 2: `Base.astro`'s nav names the site's whole shape, including routes
 * later plans have not built yet (`/tx`, `/address`, `/assets`, `/mempool`,
 * `/verify`). An entry for one of those must render as plain text, never a
 * link — a reader who clicks it would land on the 404 page. `/blocks` is the
 * one route that does exist, and must still be a real link.
 *
 * Checked on the built output, on more than one route: the nav is
 * `Base.astro` chrome and renders identically on every page in the site, so
 * a check scoped to the homepage alone would say nothing about whether the
 * layout itself is fixed.
 */

const NAV_UL = /<nav class="nav">[\s\S]*?<ul>([\s\S]*?)<\/ul>/;

function navOf(html: string): string {
  const m = NAV_UL.exec(html);
  if (m === null) throw new Error('the page has no nav <ul>');
  return m[1]!;
}

/** The nav's own `<li>` entries, in document order, tags stripped to bare label text. */
function navItems(html: string): string[] {
  return [...navOf(html).matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());
}

const BUILT = [{ href: '/blocks', label: 'Blocks' }];
const NOT_BUILT = [
  { href: '/tx', label: 'Transactions' },
  { href: '/address', label: 'Addresses' },
  { href: '/assets', label: 'Assets' },
  { href: '/mempool', label: 'Mempool' },
  { href: '/verify', label: 'Verify' },
];

// A handful of routes with genuinely different templates, not every page in
// the build — the nav is identical `Base.astro` chrome everywhere, so more
// than this would just re-check the same markup.
const PAGES = ['index.html', 'blocks/index.html', '404.html'];

describe('nav entries for routes that do not exist yet', () => {
  it('finds the pages it means to check', () => {
    // Anti-vacuity: a rename that dropped one of these from the build would
    // otherwise silently shrink what this file actually covers.
    for (const page of PAGES) expect(distPages(), `${page} is not in the build`).toContain(page);
  });

  for (const page of PAGES) {
    it(`renders unbuilt nav entries as plain text, not links, on ${page}`, () => {
      const nav = navOf(readDist(page));
      for (const entry of NOT_BUILT) {
        expect(
          nav,
          `${page}'s nav links to ${entry.href}, which the build does not produce`,
        ).not.toContain(`href="${entry.href}"`);
        expect(nav, `${page}'s nav is missing the "${entry.label}" entry`).toContain(entry.label);
      }
    });

    it(`keeps the built entry a real link on ${page}`, () => {
      const nav = navOf(readDist(page));
      for (const entry of BUILT) {
        expect(nav, `${page}'s nav does not link ${entry.href}`).toContain(`href="${entry.href}"`);
      }
    });
  }

  it('keeps all six entries in their original order and wording', () => {
    // The fix's own constraint: the entries describe the site's shape and
    // are not to be removed, reordered or reworded — only relinked.
    expect(navItems(readDist('index.html'))).toEqual([
      'Blocks',
      'Transactions',
      'Addresses',
      'Assets',
      'Mempool',
      'Verify',
    ]);
  });

  it('styles the not-yet-available entries through a token, never a literal colour', () => {
    // Eleven reader-selectable palettes (src/styles/tokens.css) redefine
    // --dim, --acc etc.; a literal hex here would be wrong under ten of
    // them. Scoped to the rule this fix added, the same way
    // tests/site/pending-render.test.ts pins `.c-state` — a whole-file scan
    // would also trip on colours other rules already declare correctly.
    const css = readFileSync('src/styles/base.css', 'utf8');
    const rule = /\.nav li \.soon\s*\{[^}]*\}/.exec(css);
    expect(rule, '.nav li .soon rule not found in base.css').not.toBeNull();
    expect(rule![0]).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });
});

/**
 * Every internal link on every built page, whole-document — not scoped to
 * `<main>`. Task 6's link-integrity test had to scope itself there because
 * the nav's dead links made an unscoped check fail on every single page;
 * with Fix 2 landed, the nav links nowhere that does not exist, so this is
 * the real guarantee: nothing anywhere in a built page 404s.
 */

/** Absolute site-internal hrefs anywhere in a document, deduplicated. */
function internalHrefs(html: string): string[] {
  return [...new Set([...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!))];
}

/**
 * True when a site-internal href has something in `dist` to land on — a
 * page (`/blocks` → `dist/blocks/index.html`) or a built asset
 * (`/_astro/Base.abc123.css`), which a whole-document scan also turns up.
 *
 * The plain `existsSync(join(DIST, clean))` half must reject a bare
 * directory: `dist/tx/` exists as soon as any one post builds, as a
 * container for `dist/tx/<slug>/`, even when `/tx` itself names no page.
 * Accepting it as a hit would have let this very test pass with a bare
 * `href="/tx"` restored to the nav — the one mutation this file exists to
 * catch — because the directory it groups real pages under is real.
 */
function resolves(href: string): boolean {
  const clean = href.replace(/[?#].*$/, '').replace(/^\//, '').replace(/\/$/, '');
  if (clean === '') return existsSync(join(DIST, 'index.html'));
  if (existsSync(join(DIST, clean, 'index.html'))) return true;
  const path = join(DIST, clean);
  return existsSync(path) && !statSync(path).isDirectory();
}

/**
 * `TxPanel.astro` links each post's tags and series to `/address/<tag>.tag`
 * and `/address/<series>.series` — the same class of "link to a route from a
 * later plan" that this file otherwise catches, but a pre-existing, already
 * and separately tested design (`tests/site/post-page.test.ts` — "links to
 * each tag address the post sent to"). Fix 2 named only `Base.astro:29-33`;
 * changing TxPanel's links would fail that other, intentional test and was
 * never in scope here. Excluded explicitly, rather than the check silently
 * passing: an unscoped version of this test fails on every build today for
 * a reason that has nothing to do with the nav, which is what this file is
 * actually proving.
 */
const KNOWN_PREEXISTING_DEAD_LINK = /^\/address\/[^/]+\.(tag|series)$/;

describe('link integrity across the whole page', () => {
  it('finds more than one page to check', () => {
    expect(distPages().length).toBeGreaterThan(1);
  });

  it('no link anywhere in any built page 404s, aside from the pre-existing tag/series address links', () => {
    let checked = 0;
    for (const page of distPages()) {
      const hrefs = internalHrefs(readDist(page)).filter((h) => !KNOWN_PREEXISTING_DEAD_LINK.test(h));
      checked += hrefs.length;
      for (const href of hrefs) {
        expect(resolves(href), `${href} is linked from ${page} but was never built`).toBe(true);
      }
    }
    // Anti-vacuity: every page above emitting zero internal links would pass
    // this file having checked nothing.
    expect(checked).toBeGreaterThan(0);
  });
});
