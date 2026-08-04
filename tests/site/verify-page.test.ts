import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, cssPerPage, distPages, readDist, rendered, resolvesIn, scriptClosure } from './dist';
import { parseRules, selectorParts } from './css';
import { ROUTES, routeById } from '../../src/site/routes';
import { CHECKS } from '../../src/site/verify-checks';

/**
 * §7 — `/verify`, the page that lets a reader check the chain instead of
 * believing it.
 *
 * Everything here reads the build, not the sources: the island's whole risk is
 * that it passes in Node and fails in a browser, and the only artefact that
 * can say otherwise is the JavaScript actually shipped to `dist/`.
 */

const PAGE = 'verify/index.html';

function mainOf(html: string): string {
  const m = /<main>([\s\S]*?)<\/main>/.exec(html);
  if (m === null) throw new Error('the built page has no <main>');
  return m[1]!;
}

/** Visible text, tags stripped — so a class name can never satisfy a prose assertion. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('/verify is built, linked and reachable', () => {
  it('is in the build', () => {
    expect(distPages()).toContain(PAGE);
  });

  it('is a built route, so the nav links it instead of greying it out', () => {
    expect(routeById('verify').built).toBe(true);
    expect(ROUTES.map((r) => r.id)).toContain('verify');
    for (const page of ['index.html', 'blocks/index.html', PAGE]) {
      expect(readDist(page), `${page} does not link /verify`).toContain('href="/verify"');
    }
    expect(resolvesIn(DIST, '/verify')).toBe(true);
  });
});

describe('with JavaScript disabled', () => {
  it('says, in the page itself, that it needs JavaScript', () => {
    expect(readDist(PAGE)).toMatch(/JavaScript/);
  });

  it('explains what verification is rather than rendering an empty shell', () => {
    // Everything else on this site works with scripts off. This page cannot —
    // so with them off it has to be worth reading anyway: what is checked, on
    // what document, and why the reader should not simply believe the word
    // "verified" printed somewhere else.
    const body = text(mainOf(readDist(PAGE)));
    expect(body.length, 'the page is an empty shell without JavaScript').toBeGreaterThan(600);
    expect(body).toContain('/chain.json');
    for (const check of CHECKS) {
      expect(body, `the static page never names the ${check.label} check`).toContain(check.label);
      expect(body, `the static page never explains ${check.label}`).toContain(text(rendered(check.note)));
    }
  });

  it('says why the open block is not part of this check', () => {
    // §3.6 — a pending transaction carries a real hash but no mined block, so
    // there is no proof of work and no Merkle root to recompute. Leaving it out
    // silently would let a reader take "chuỗi hợp lệ" as covering the posts
    // they can see on /blocks but which nothing here checked.
    const body = text(mainOf(readDist(PAGE)));
    expect(body).toMatch(/khối đang mở/i);
    expect(body).toMatch(/chain\.pending\.json/);
    expect(mainOf(readDist(PAGE))).toContain('href="/blocks"');
  });
});

describe('what actually reaches the browser', () => {
  it('loads at least one module script, and every file it imports resolves', () => {
    // Anti-vacuity for every assertion below: a page that shipped no script at
    // all would satisfy each of them by having nothing to scan.
    const { files, code } = scriptClosure(PAGE);
    expect(files.length, '/verify ships no JavaScript at all').toBeGreaterThan(0);
    for (const file of files) {
      expect(existsSync(join(DIST, file.replace(/^\//, ''))), `${file} is not in the build`).toBe(true);
    }
    expect(code.length).toBeGreaterThan(1000);
  });

  it('ships the very same verifier the build runs, not a copy of it', () => {
    // Strings only `src/chain/verify.ts` produces. §7's constraint is that one
    // module proves the chain in both places; if this bundle stopped carrying
    // it, the tab and the build could disagree and nothing else would notice.
    const { code } = scriptClosure(PAGE);
    expect(code).toContain('is not a 0x-prefixed');
    expect(code).toContain('is out of first-appearance order');
  });

  it('hashes with the browser\'s own WebCrypto, not a polyfill of a Node module', () => {
    // The failure this rules out: a bundler resolving `node:crypto` to a
    // shimmed implementation would produce a verifier that passes every Node
    // test and dies on load in a real tab. `src/chain/hash.ts` calls
    // `crypto.subtle.digest('SHA-256', …)`, which is the browser's own.
    const { code } = scriptClosure(PAGE);
    expect(code).toContain('SHA-256');
    expect(code).toMatch(/subtle\.digest/);
    expect(code, 'a node: specifier reached the browser bundle').not.toContain('node:');
    expect(code, 'a CommonJS require() reached the browser bundle').not.toMatch(/\brequire\s*\(/);
    expect(code, 'a Node global was polyfilled into the bundle').not.toMatch(/\bBuffer\b|\bprocess\.env\b/);
  });

  it('fetches nothing but a same-origin path (§9)', () => {
    const { code } = scriptClosure(PAGE);
    expect(code, 'the island does not fetch the ledger at all').toMatch(
      /fetch\(\s*["'`]\/chain\.json/,
    );
    // Every fetch target in the bundle, whatever it is spelled as.
    for (const m of code.matchAll(/fetch\(\s*(["'`])([^"'`]*)\1/g)) {
      expect(m[2]!.startsWith('/'), `the island fetches ${m[2]!}, which is not same-origin`).toBe(true);
    }
    expect(code, 'the bundle names an absolute url').not.toMatch(/https?:\/\//);
  });

  it('lets no built page load a script that names a third party', () => {
    // The same §9 rule the HTML and CSS already have a guard for. Nothing
    // covered JavaScript, because until now the site shipped none.
    let scanned = 0;
    for (const page of distPages()) {
      const { code } = scriptClosure(page);
      if (code === '') continue;
      scanned += 1;
      expect(code, `${page} loads a script that names a third party`).not.toMatch(/https?:\/\//);
    }
    expect(scanned, 'no built page loads a script, so this checked nothing').toBeGreaterThan(0);
  });
});

describe('the island renders every check the verifier runs', () => {
  it('carries each check label and the field it reports', () => {
    const { code } = scriptClosure(PAGE);
    for (const check of CHECKS) {
      expect(code, `the bundle never labels ${check.label}`).toContain(check.label);
      expect(code, `the bundle never reads ${check.field}`).toContain(check.field);
    }
  });

  it('names exactly the verdict fields BlockVerification carries', () => {
    // A check list that drifted from `BlockVerification` would either invent a
    // check the verifier does not run or quietly stop showing one it does —
    // and the reader would have no way to tell either from the page.
    const source = readFileSync('src/chain/verify.ts', 'utf8');
    const shape = /export interface BlockVerification \{([\s\S]*?)\n\}/.exec(source);
    expect(shape, 'BlockVerification is no longer declared as an interface').not.toBeNull();
    const declared = [...shape![1]!.matchAll(/^\s{2}(\w+Ok)\??:/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(CHECKS.map((c) => c.field).sort()).toEqual(declared.sort());
  });
});

describe('the page under eleven palettes', () => {
  /** Named so a rename cannot silently shrink what the colour scan covers. */
  const RULES = ['.vfy-stamp', '.vfy-check', '.vfy-mark', '.vfy-status'];

  it('uses no hard-coded colour anywhere in the verify stylesheet', () => {
    // Read inside the test, never at module level: a top-level throw fails the
    // whole file at import and hides which assertion actually broke.
    const rules = parseRules(readFileSync('src/styles/verify.css', 'utf8'));
    expect(rules.length, 'verify.css parsed to no rules at all').toBeGreaterThan(0);
    const selectors = new Set(rules.flatMap(selectorParts));
    for (const rule of RULES) {
      expect(
        [...selectors].some((s) => s.split(/\s+/).includes(rule) || s.includes(rule)),
        `${rule} is not a rule in verify.css — the guard is not scanning it`,
      ).toBe(true);
    }
    for (const rule of rules) {
      expect(rule.body, `${rule.selector} hard-codes a colour instead of using a token`).not.toMatch(
        /#[0-9a-f]{3,8}\b|rgba?\(/i,
      );
    }
  });

  it('actually ships those rules to the built page', () => {
    // A stylesheet nothing imports never reaches `dist`, and the page would
    // render unstyled with a fully green colour scan.
    const css = cssPerPage().get(PAGE);
    expect(css, `${PAGE} loads no CSS at all`).toBeDefined();
    for (const rule of RULES) {
      expect(
        parseRules(css!).some((r) => selectorParts(r).some((p) => p.split(/\s+/).includes(rule))),
        `built css for ${PAGE} has no rule for ${rule}`,
      ).toBe(true);
    }
  });
});

describe('the page is derived, not dated', () => {
  it('reads no clock (§14)', () => {
    expect(readFileSync('src/site/verify-checks.ts', 'utf8')).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    expect(readFileSync('src/pages/verify.astro', 'utf8')).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    expect(readFileSync('src/components/ChainVerifier.astro', 'utf8')).not.toMatch(
      /new Date\(\)|Date\.now\(\)/,
    );
  });
});
