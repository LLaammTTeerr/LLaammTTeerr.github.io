import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DIST = 'dist';

/**
 * True when a site-internal href has something in `distRoot` to land on — a
 * page (`/blocks` → `blocks/index.html`) or a built asset
 * (`/_astro/Base.abc123.css`), which a whole-document scan also turns up.
 *
 * The plain-file half must reject a bare directory: `dist/tx/` exists as soon
 * as any one post builds, as a container for `dist/tx/<slug>/`, even when
 * `/tx` itself names no page. Accepting it as a hit would let a link check
 * pass with a bare `href="/tx"` restored to the nav — the one mutation that
 * check exists to catch — because the directory grouping the real pages is
 * itself real.
 *
 * One definition, used by every link check in the suite. Two of them had
 * drifted: `block-routes.test.ts` still carried the version without the
 * `isDirectory()` rejection, latent only because `<main>` happens to emit no
 * bare directory href today.
 */
export function resolvesIn(distRoot: string, href: string): boolean {
  const clean = href.replace(/[?#].*$/, '').replace(/^\//, '').replace(/\/$/, '');
  if (clean === '') return existsSync(join(distRoot, 'index.html'));
  if (existsSync(join(distRoot, clean, 'index.html'))) return true;
  const path = join(distRoot, clean);
  return existsSync(path) && !statSync(path).isDirectory();
}

/** Absolute site-internal hrefs in a fragment or document, deduplicated. */
export function internalHrefs(html: string): string[] {
  return [...new Set([...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!))];
}

/**
 * Read a file from the build output, with an error that says what to do.
 * Call this INSIDE a test, never at module top level — a top-level throw
 * fails the entire file at import time and hides which assertion broke.
 *
 * `dist/` is built by vitest's globalSetup (tests/global-setup.ts) before
 * any test runs, so it is always current with the sources under test.
 */
export function readDist(relPath: string): string {
  const path = join(DIST, relPath);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the build in tests/global-setup.ts should have produced it`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * Every stylesheet the built homepage actually loads, concatenated: the
 * hashed `_astro/*.css` bundles it links plus any `<style>` Astro chose to
 * inline. Assertions about what reaches the browser must read this, not the
 * source CSS — a source file no component imports never reaches `dist`.
 */
export function readDistCss(): string {
  return cssLoadedBy('index.html');
}

/** Every stylesheet one built page loads, plus its inline `<style>` blocks. */
function cssLoadedBy(page: string): string {
  const html = readDist(page);
  const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => {
    const href = m[1]!;
    // A stylesheet on another origin has no file in `dist` to read. Say so,
    // rather than failing with a confusing "not found" for `dist/https:/…`.
    if (/^(https?:)?\/\//.test(href)) {
      throw new Error(`dist/${page} links a third-party stylesheet: ${href}`);
    }
    return readDist(href.replace(/^\//, ''));
  });
  const inlined = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
  const all = [...linked, ...inlined];
  if (all.length === 0) throw new Error(`dist/${page} loads no CSS at all`);
  return all.join('\n');
}

/**
 * Every HTML page in the build, as paths relative to `dist/`.
 *
 * Guards that read only `index.html` are guards over one route. The post page
 * is the one that vendored KaTeX and its own 30 KB bundle, and it was invisible
 * to every such guard: a CDN stylesheet and a tracking pixel added to
 * `[slug].astro` shipped with a fully green suite. Anything asserted about
 * "the built page" must iterate this.
 */
export function distPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) out.push(relative(DIST, path).split(sep).join('/'));
    }
  };
  walk(DIST);
  return out.sort();
}

/** Every stylesheet reachable from any built page, keyed by the page. */
export function cssPerPage(): Map<string, string> {
  return new Map(distPages().map((page) => [page, cssLoadedBy(page)]));
}

/**
 * Strips XML namespace identifiers, which look like URLs and are not requests.
 *
 * KaTeX emits `xmlns="http://www.w3.org/1998/Math/MathML"` on every formula
 * and Astro emits the SVG namespace, so the moment a post contains `$O(n)$`
 * the page gains an `http://` substring that no browser ever fetches. The
 * exclusion is deliberately narrow: only the `xmlns` and `xmlns:*` attributes.
 * An `xlink:href` or a `<use href>` pointing at another origin *is* a request
 * and must still be caught.
 */
export function withoutNamespaceUris(html: string): string {
  return html.replace(/\sxmlns(:[a-zA-Z0-9_-]+)?="[^"]*"/g, '');
}

/**
 * Strips the `href` value out of every `<a>` tag, leaving every other
 * `http(s)://` occurrence in the document intact.
 *
 * An anchor's `href` is a navigation target the reader chooses to follow, not
 * a resource the page fetches on load — unlike a `<script src>`, a
 * `<link rel="stylesheet" href>`, an `<img src>` or an `<svg>`'s
 * `xlink:href`, none of which wait for a click. §9 forbids a page *load*
 * touching a third party; it says nothing about a page naming one in a link
 * the reader may or may not follow, and `src/site/markdown.ts` already
 * allowlists `http`/`https` as safe URL schemes for exactly that reason
 * (`SAFE_SCHEMES`). `/about`'s profile links (`src/site/profile.ts`) are the
 * first real ones this build ships.
 *
 * Scoped to `<a ...>` tags only — matched and rewritten one attribute at a
 * time inside `[^>]*`, which cannot cross a `>` and so cannot reach into a
 * following tag. A `<link>`, `<img>`, `<script>` or any other element's own
 * `href`/`src` is untouched, so this cannot excuse the hazards the "no built
 * page references an absolute http(s) url" guard exists to catch.
 */
export function withoutAnchorHrefs(html: string): string {
  return html.replace(/<a\b[^>]*\bhref="https?:\/\/[^"]*"[^>]*>/gi, (tag) =>
    tag.replace(/href="https?:\/\/[^"]*"/i, 'href=""'),
  );
}
