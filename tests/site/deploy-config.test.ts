import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  distFiles,
  distPages,
  internalHrefs,
  internalSrcs,
  readDist,
  readDistBytes,
  withoutAnchorHrefs,
} from './dist';

/**
 * Where this site is published: the two values in `astro.config.mjs` that
 * decide it, and the build they produce.
 *
 * `site` is the one setting whose mistake ships to readers rather than showing
 * up on screen. Every url in `/rss.xml` is absolute and built from it (see
 * `src/pages/rss.xml.ts`), so a wrong value is a feed of well-formed links to
 * nothing — subscribed to once and then never re-read. `lamter.example` was
 * the placeholder, on the reserved `.example` TLD, and it reached exactly one
 * output: `dist/rss.xml`, the one file no `distPages()` loop in this suite
 * walks.
 *
 * `base` is the one that 404s a whole deploy. `LLaammTTeerr.github.io` is a
 * **user site**: GitHub Pages serves it from the domain root, so `base` is `/`.
 * A *project* site (`user.github.io/repo`) needs the repository name there, and
 * setting that here would prefix every url Astro emits — every stylesheet,
 * every font, every script — with a path the server has nothing under.
 *
 * That one is not invisible to this suite: measured, `/blogchain` in place of
 * `/` turns 17 tests across 8 files red, because the link checks resolve each
 * url against the files the build actually wrote rather than only against each
 * other (`nav.test.ts`'s "no link anywhere in any built page 404s" is the
 * structural one, and it mentions no `base` at all). What the test below adds
 * is the *diagnosis*: those failures read `/blogchain/_astro/Base.CYVQdsMF.css
 * was never built`, which names a stylesheet, and the thing whoever reads it
 * needs to know is that this is a user site and `base` belongs at `/`.
 */

const CONFIG = 'astro.config.mjs';

/** The address the author settled on, spelled as `astro.config.mjs` spells it. */
const REAL_SITE = 'https://LLaammTTeerr.github.io';

/**
 * TLDs reserved by RFC 2606 / RFC 6761. A url on one of these is well-formed,
 * resolves to nothing, and can never become real — which is what makes a
 * placeholder built from one survive every check that only asks whether a url
 * is valid.
 */
const RESERVED_TLDS = ['.example', '.invalid', '.test', '.localhost'];

/**
 * `astro.config.mjs` with its comment lines dropped.
 *
 * The comment beside `base` has to name the wrong value to warn about it, and
 * a reader looking for what the config *declares* must not find that. Lines
 * only, and only ones that open with a comment marker: a value never starts a
 * line with `//` or `*`, and stripping `//` to end-of-line generally would eat
 * the `https://` out of `site`.
 */
function configCode(): string {
  return readFileSync(CONFIG, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
}

/**
 * One key `astro.config.mjs` declares, as written.
 *
 * Read as text rather than imported, for the reason `tests/site/rss.test.ts`
 * gives: the config is JavaScript and this tsconfig has no `allowJs`. Throwing
 * when the key is absent is half the point — Astro's default `base` is already
 * `/`, so a config that declares none behaves correctly today and says nothing
 * about which kind of site this is to whoever changes it next.
 */
function declared(key: 'site' | 'base'): string {
  const match = new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(configCode());
  if (match === null) throw new Error(`${CONFIG} declares no \`${key}\``);
  return match[1]!;
}

/**
 * `site` as Astro resolves it, which is a `URL` and not the string.
 *
 * `src/pages/rss.xml.ts` is handed `context.site`, a `URL` object, and
 * `src/site/feed.ts` joins against it — so the host that reaches the feed is
 * the WHATWG-normalized one. Hostnames are case-insensitive and `new URL`
 * lowercases them, which means the config's readable spelling and the feed's
 * bytes differ in case and only in case. Pinned below rather than left to be
 * rediscovered by whoever next compares the two and finds them unequal.
 */
function resolvedSite(): string {
  return new URL(declared('site')).href;
}

/* ------------------------------------------------------------------ *
 * `site`
 * ------------------------------------------------------------------ */

describe('the address this site is published at', () => {
  it("points at the site's real address", () => {
    expect(declared('site')).toBe(REAL_SITE);
  });

  it('is an address that can resolve at all', () => {
    // The property the placeholder failed, stated on its own so it keeps
    // holding for whatever the value becomes next. A `.example` host is not a
    // typo a reader can recover from; it is a domain nobody may ever register.
    const host = new URL(declared('site')).hostname;
    for (const tld of RESERVED_TLDS) {
      expect(host.endsWith(tld), `${host} is on the reserved TLD ${tld}`).toBe(false);
    }
    expect(new URL(declared('site')).protocol).toBe('https:');
  });

  it('is the address the shipped feed is actually built from', () => {
    // The coupling, on the feed this repository ships. `rss.test.ts` proves the
    // same coupling against a *different* domain in a sandbox, which is what
    // rules out a hard-coded host; this proves the shipped bytes agree with the
    // shipped config, which is what rules out a stale `dist/`.
    const site = resolvedSite();
    // The case fold, pinned: `new URL` lowercases the host, so this — not the
    // config's spelling — is the string a subscriber's aggregator will store.
    expect(site).toBe('https://llaammtteerr.github.io/');

    const xml = readDist('rss.xml');
    const urls = [...xml.matchAll(/https?:\/\/[^\s"'<>]+/g)]
      .map((m) => m[0])
      // The Atom namespace identifier, which is not a url anything follows —
      // the same distinction `urlsIn` draws in `rss.test.ts`.
      .filter((u) => !u.startsWith('http://www.w3.org/'));
    expect(urls.length, 'the feed states no url at all').toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(site), `${url} in the feed is not under ${site}`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * No placeholder survives
 * ------------------------------------------------------------------ */

/**
 * The placeholders this build must not ship.
 *
 * `lamter.example` is the retired origin, and it is here as a literal because
 * "the old value is gone" is the one thing a check written after the change
 * can still prove. `example.com` and `your-handle` come with it: they are the
 * other two spellings this repository has actually shipped by accident.
 */
const PLACEHOLDER = /lamter\.example|example\.com|your-handle/i;

/**
 * One built file, as the placeholder scan reads it.
 *
 * **What is scanned:** every byte of every file in `dist/` — pages, `rss.xml`,
 * `chain.json`, `chain.pending.json`, the stylesheets and the fonts.
 *
 * **What is excluded, and why:** the `href` of an `<a>` in a built page, and
 * nothing else. Those are the external links the author writes in `content/`
 * — the profile's social links (`content/profile.md`) and a contract's source
 * repository (`content/contracts/*.md`) — and they are not derived from `site`;
 * they are the author's to fill in, deliberately deferred, and the demo corpus
 * ships `https://github.example/…` on purpose (`tests/site/contracts.test.ts`
 * requires demo repos to be obviously fake, so a scan that failed on them
 * would fail on the corpus the author asked to keep seeded). They already have
 * their own guards: `about.test.ts` refuses a placeholder profile url on the
 * page as built, and `contracts.test.ts` refuses a demo repo that looks real.
 *
 * The exclusion is exactly `withoutAnchorHrefs`, whose own tests in
 * `dist-output.test.ts` pin that it strips an anchor's `href` and nothing else
 * — not a `<link>`, not an `<img src>`, not the anchor's text. Everything the
 * build derives from `site` — the feed's `<link>`, `<guid>` and `<atom:link>`,
 * any canonical or `og:url` a page grows later — is inside the scan.
 */
function scanned(file: string): string {
  const bytes = readDistBytes(file);
  return file.endsWith('.html') ? withoutAnchorHrefs(bytes) : bytes;
}

describe('no placeholder host survives into the build', () => {
  it('finds the whole build to check, feed included', () => {
    // Anti-vacuity, and specifically about the one file that carried the
    // placeholder: a scan that walked only `distPages()` would have been green
    // against a `dist/rss.xml` full of `lamter.example`.
    const files = distFiles();
    expect(files.length).toBeGreaterThan(distPages().length);
    expect(files).toContain('rss.xml');
    expect(files).toContain('index.html');
  });

  it('carries no placeholder host anywhere in the build', () => {
    for (const file of distFiles()) {
      expect(scanned(file), `${file} still names a placeholder host`).not.toMatch(PLACEHOLDER);
    }
  });

  it('would catch a placeholder in any of the shapes it could survive in', () => {
    // The check above is an absence, and an absence proves nothing about the
    // checker. These are the places `lamter.example` could actually come back:
    // the feed's elements, a canonical link, a stylesheet url, prose.
    for (const shape of [
      '<link>https://lamter.example/tx/x</link>',
      '<guid isPermaLink="true">https://lamter.example/tx/x</guid>',
      '<atom:link href="https://lamter.example/rss.xml" rel="self" />',
      '<link rel="canonical" href="https://lamter.example/">',
      '<meta property="og:url" content="https://lamter.example/">',
      'body { background: url(https://lamter.example/x.png); }',
      '<p>viết ở lamter.example</p>',
    ]) {
      expect(withoutAnchorHrefs(shape), `${shape} would slip past the scan`).toMatch(PLACEHOLDER);
    }
  });

  it('excuses an author-written external link, and only that', () => {
    // The exclusion, stated as behaviour. The first is what the author defers;
    // the rest are what the build itself would be emitting, and none of them
    // is excused.
    expect(withoutAnchorHrefs('<a href="https://github.com/your-handle">GitHub</a>')).not.toMatch(
      PLACEHOLDER,
    );
    expect(withoutAnchorHrefs('<a href="/x">your-handle</a>')).toMatch(PLACEHOLDER);
    expect(withoutAnchorHrefs('<img src="https://lamter.example/x.png">')).toMatch(PLACEHOLDER);
    expect(withoutAnchorHrefs('<link rel="canonical" href="https://lamter.example/">')).toMatch(
      PLACEHOLDER,
    );
  });
});

/* ------------------------------------------------------------------ *
 * `base`
 * ------------------------------------------------------------------ */

describe('the path this site is served from', () => {
  it('serves from the domain root, as a user site does', () => {
    // `LLaammTTeerr/LLaammTTeerr.github.io` is a user site. Declared rather
    // than defaulted: Astro's default is `/` too, so a config that says nothing
    // is right by accident and tells the next reader nothing.
    expect(declared('base')).toBe('/');
    expect(readDist('index.html')).not.toMatch(/href="\/blogchain\//);
  });

  it('prefixes no url the build emits with a repository name', () => {
    // Every page, not just the homepage, and `src` as well as `href`: the urls
    // a wrong `base` moves are the ones Astro generates — the hashed
    // stylesheets, the fonts they pull — and those live in `<head>` and in
    // `<link>`s a homepage-only check would still see, but a page that grows
    // its own bundle later would not.
    let generated = 0;
    for (const page of distPages()) {
      const html = readDist(page);
      for (const url of [...internalHrefs(html), ...internalSrcs(html)]) {
        if (!url.includes('/_astro/')) continue;
        generated += 1;
        expect(url.startsWith('/_astro/'), `${page} loads ${url}, which a base has moved`).toBe(
          true,
        );
      }
    }
    // Anti-vacuity: a build that emitted no bundled asset at all would satisfy
    // the loop above while proving nothing.
    expect(generated, 'no built page loads a generated asset').toBeGreaterThan(0);
  });

  // There is deliberately no "every url resolves to a file the build wrote"
  // test here. `nav.test.ts` already walks every page and every href through
  // `resolvesIn`, and that is the check a wrong `base` trips first — a second
  // copy of it under a `base` heading would add a name, not a guarantee.
});
