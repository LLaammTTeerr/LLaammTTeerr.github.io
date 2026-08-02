import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DIST, distPages, internalHrefs, readDist, resolvesIn } from './dist';
import { ROUTES } from '../../src/site/routes';

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

// Read from src/site/routes.ts, the single list Base.astro's nav and
// TxPanel's tag/series links both render from — not re-declared here, so
// this file cannot silently drift from what the site actually ships.
const BUILT = ROUTES.filter((r) => r.built);
const NOT_BUILT = ROUTES.filter((r) => !r.built);

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

/**
 * The shared resolver (see `resolvesIn` in ./dist), bound to this repo's own
 * `dist`. Shared rather than re-declared so `block-routes.test.ts` cannot go
 * on carrying the version without the bare-directory rejection.
 */
const resolves = (href: string): boolean => resolvesIn(DIST, href);

describe('link integrity across the whole page', () => {
  it('finds more than one page to check', () => {
    expect(distPages().length).toBeGreaterThan(1);
  });

  it('checks a dotted-looking href as a route, not skips it as a static file', () => {
    // `/address/<tag>.tag` looks like a filename (a dot before the end), but
    // it is a route this app defines, not a static asset. A resolver that
    // special-cased "the last path segment has a dot in it" to mean "skip,
    // probably a file" would silently stop checking exactly this shape of
    // link — which is precisely how `TxPanel.astro`'s dead `/address/<tag>.tag`
    // links shipped past an earlier, unscoped link check. `resolves` here
    // makes no such exception: it only ever asks the filesystem.
    expect(resolves('/address/meta.tag')).toBe(false);
    expect(resolves('/blocks')).toBe(true);
  });

  it('no link anywhere in any built page 404s', () => {
    let checked = 0;
    for (const page of distPages()) {
      const hrefs = internalHrefs(readDist(page));
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
