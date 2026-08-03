import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DIST, distPages, internalHrefs, internalSrcs, readDist, resolvesIn } from './dist';
import { ROUTES } from '../../src/site/routes';
import { getAddresses } from '../../src/site/addresses';

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

  it('keeps every entry in its original order and wording', () => {
    // The fix's own constraint: the entries describe the site's shape and
    // are not to be removed, reordered or reworded — only relinked. `About`
    // is a later addition (the author's own address page, src/pages/about.astro)
    // and belongs first: it is about the author, not the chain, so it reads
    // as the entry point ahead of the explorer sections proper.
    expect(navItems(readDist('index.html'))).toEqual([
      'About',
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

  it('checks a dotted-looking href as a route, not skips it as a static file', async () => {
    // `/address/<tag>.tag` looks like a filename (a dot before the end), but
    // it is a route this app defines, not a static asset. A resolver that
    // special-cased "the last path segment has a dot in it" to mean "skip,
    // probably a file" would silently stop checking exactly this shape of
    // link — which is precisely how `TxPanel.astro`'s dead `/address/<tag>.tag`
    // links shipped past an earlier, unscoped link check. `resolves` here
    // makes no such exception: it only ever asks the filesystem.
    //
    // Both halves, now that the route is built: every dotted address route the
    // chain produces resolves, and a dotted href with no page behind it is
    // still reported dead. A resolver that skipped dots would answer `true` to
    // both — the second assertion is the one that catches it.
    const names = (await getAddresses()).map((a) => a.name);
    expect(names.length, 'the chain produced no address routes to check').toBeGreaterThan(0);
    for (const name of names) {
      expect(name, `${name} has no dot, so it does not exercise this at all`).toContain('.');
      expect(resolves(`/address/${name}`), `/address/${name} was never built`).toBe(true);
    }
    expect(resolves('/address/khong-ton-tai.tag')).toBe(false);
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

  /**
   * The same guarantee for `src`, which every link check in this suite used to
   * skip. That omission is how a build shipping no `content/assets/` at all
   * went unnoticed: a post embedding `![Sơ đồ](/assets/so-do.svg)` renders an
   * `<img src>` that 404s, and reading only `href` cannot see it.
   *
   * **This assertion is vacuous on the live repository today** — the author has
   * published no image, so no built page emits a site-internal `src` at all,
   * and a count-based anti-vacuity check here would fail for that reason alone.
   * It is a standing guarantee for the day an image is published, and it is
   * NOT the evidence that the copy works: `tests/site/asset-files.test.ts`
   * drives a real image through a real build and checks every `src` in the
   * *sandbox's* dist, which is the check that goes red when the copy is
   * removed. What is asserted here instead is that the machinery would report
   * a miss rather than shrug — see the two checks below.
   */
  it('reports a missing src rather than skipping it', () => {
    expect(internalSrcs('<img src="/assets/so-do.svg" alt="">')).toEqual(['/assets/so-do.svg']);
    expect(resolves('/assets/khong-ton-tai.svg')).toBe(false);
  });

  it('reads every candidate in a srcset, not just the first', () => {
    // A responsive image shipping one resolvable candidate beside one dead one
    // would pass a check that read `src` alone, or one that took `srcset` as a
    // single url. Each entry is `<url> <descriptor>`, comma-separated.
    expect(internalSrcs('<img src="/a.png" srcset="/a.png 1x, /b.png 2x">')).toEqual([
      '/a.png',
      '/b.png',
    ]);
    expect(internalSrcs('<img srcset="/hep.png 480w,   /rong.png 1200w">')).toEqual([
      '/hep.png',
      '/rong.png',
    ]);
  });

  it('reads a data: uri and a third-party url as neither internal nor missing', () => {
    // A token page's embed carries its own bytes (src/site/assets-view.ts), so
    // it fetches nothing from `dist` and must not be demanded of it. A
    // third-party url is a separate guard's business (dist-output.test.ts).
    expect(internalSrcs('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toEqual([]);
    expect(internalSrcs('<img src="https://evil.example.com/pixel.gif">')).toEqual([]);
  });

  it('no src anywhere in any built page 404s', () => {
    for (const page of distPages()) {
      for (const src of internalSrcs(readDist(page))) {
        expect(resolves(src), `${src} is sourced by ${page} but is not in the build`).toBe(true);
      }
    }
  });
});
