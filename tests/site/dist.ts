import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DIST = 'dist';

/**
 * A url path as the filesystem name it addresses.
 *
 * A browser percent-decodes before it asks for anything, and a static host
 * decodes before it looks on disk, so a check that compares the *encoded* path
 * against `dist/` is not modelling either of them: `/contract/m%C3%A1y%20ch…`
 * would be reported dead while pointing squarely at
 * `dist/contract/máy chủ & mcp/index.html`. Contracts are what made this
 * reachable — the first slugs on this site that are freeform prose rather than
 * ASCII — and a link check that cannot tell an encoding artefact from a real
 * dead link is worse than no message at all.
 *
 * A malformed escape (`%zz`) is left exactly as written. It is not a path any
 * browser can resolve either, so the check that follows should, and does, call
 * it dead.
 */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

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
  const clean = decodePath(href.replace(/[?#].*$/, '').replace(/^\//, '').replace(/\/$/, ''));
  // `join` would normalize a `..` away and look outside `dist/` — so a page
  // linking `/x/..%2F..%2Fpackage.json` would be reported as resolving, against
  // a file that is not on the site at all. Decoding is what makes that spelling
  // reachable here, so the rejection arrives with it.
  if (clean.split('/').includes('..')) return false;
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
 * Absolute site-internal `src` and `srcset` urls in a fragment or document,
 * deduplicated.
 *
 * The sibling of `internalHrefs`, and the reason this file grew one: every
 * link check in the suite read `href`, and an image uses `src`. Nothing
 * copied `content/assets/` into `dist`, so every `![…](/assets/…)` in every
 * post rendered an `<img src>` that 404ed, with 661 tests green.
 *
 * Absolute urls only, exactly as `internalHrefs` does: a `data:` uri carries
 * its own bytes and fetches nothing (that is what every token page's embed
 * is), and an `http(s)://` url is a third party, which is a different guard's
 * job (`no built page references an absolute http(s) url`).
 *
 * `srcset` is a comma-separated list of `<url> <descriptor>` candidates, so
 * each entry's url is its first whitespace-delimited token. A responsive
 * image that shipped one resolvable candidate and one dead one would
 * otherwise pass a check that only read `src`.
 */
export function internalSrcs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\bsrc="([^"]*)"/g)) {
    if (m[1]!.startsWith('/')) out.push(m[1]!);
  }
  for (const m of html.matchAll(/\bsrcset="([^"]*)"/g)) {
    for (const candidate of m[1]!.split(',')) {
      const url = candidate.trim().split(/\s+/)[0] ?? '';
      if (url.startsWith('/')) out.push(url);
    }
  }
  return [...new Set(out)];
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
 * A chain value as the built HTML actually carries it.
 *
 * Astro escapes every interpolated expression through `html-escaper`, which
 * replaces `&`, `<`, `>`, `'` and `"` — so a post titled `Mo's algorithm` is in
 * `dist` as `Mo&#39;s algorithm` and `toContain(tx.title)` fails on a page that
 * rendered the title perfectly. Nothing about that failure points at the
 * apostrophe, and the first title with punctuation in it turns several tests
 * red at once.
 *
 * One definition, used by every assertion in the suite that compares a value
 * read off the chain against rendered markup. Never applied to a string the
 * test wrote as markup — only to the data interpolated into it.
 */
export function rendered(value: string): string {
  return value.replace(/[&<>'"]/g, (c) => ESCAPES[c] ?? c);
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
};

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
export function distPages(distRoot: string = DIST): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) out.push(relative(distRoot, path).split(sep).join('/'));
    }
  };
  walk(distRoot);
  return out.sort();
}

/**
 * Every file in the build, as paths relative to `dist/` — pages, the feed, the
 * chain documents, the stylesheets, the fonts.
 *
 * The sibling of `distPages`, and the reason this file grew one: the
 * placeholder origin `lamter.example` reached exactly one output, `dist/rss.xml`,
 * which is not HTML and which every `distPages()` loop in the suite therefore
 * walked straight past. A guard over "the build" that only reads pages is a
 * guard over a third of the bytes shipped.
 */
export function distFiles(distRoot: string = DIST): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(distRoot, path).split(sep).join('/'));
    }
  };
  walk(distRoot);
  return out.sort();
}

/**
 * One built file as bytes-as-characters, so a scan over the whole build can
 * include the fonts and any other binary without decoding them.
 *
 * `latin1` maps every byte to exactly one character, so an ASCII needle like
 * `lamter.example` is found wherever it sits. Reading a `.woff2` as `utf8`
 * would replace invalid sequences with U+FFFD, and a needle straddling one
 * would be silently lost — the failure mode a whole-build scan exists to rule
 * out. Never use this to compare rendered text: use `readDist`.
 */
export function readDistBytes(relPath: string): string {
  return readFileSync(join(DIST, relPath), 'latin1');
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

/**
 * The one `<li>` a post occupies in a transaction list, or `null`.
 *
 * Scoped to the row rather than to the card: "the page contains 44 từ
 * somewhere" is satisfied by any other row, by a header figure, or by a number
 * that belongs to a different post entirely.
 */
export function rowFor(html: string, slug: string): string | null {
  for (const m of html.matchAll(/<li>[\s\S]*?<\/li>/g)) {
    if (m[0].includes(`href="/tx/${slug}"`)) return m[0];
  }
  return null;
}
