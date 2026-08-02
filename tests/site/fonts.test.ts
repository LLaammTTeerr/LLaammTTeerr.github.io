import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { hasVietnameseSubset } from '../../scripts/check-vietnamese';

describe('font coverage', () => {
  it('the prose face ships a vietnamese subset', () => {
    expect(hasVietnameseSubset('node_modules/@fontsource/be-vietnam-pro')).toBe(true);
  });

  it('the monospace face ships a vietnamese subset', () => {
    // Hashes sit beside Vietnamese titles in the same table; the mono face
    // must cover both or titles break mid-word. Call the real checker
    // against the real vendored package — asserting against fonts.css's own
    // text proved nothing, since any `@fontsource/...` string anywhere in
    // the file (even the prose face's) would have satisfied a regex match.
    expect(hasVietnameseSubset('node_modules/@fontsource/jetbrains-mono')).toBe(true);
  });
});

describe('fonts.css', () => {
  const css = readFileSync('src/styles/fonts.css', 'utf8');

  it('exists and imports the vendored vietnamese and latin subsets', () => {
    expect(existsSync('src/styles/fonts.css')).toBe(true);
    expect(css).toContain('@fontsource/be-vietnam-pro/vietnamese-400.css');
    expect(css).toContain('@fontsource/jetbrains-mono/vietnamese-400.css');
  });

  it('self-hosts — no external url', () => {
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('does not declare a competing @font-face that could shadow the vendored rules', () => {
    // A hand-written @font-face here (even one meant only to "document" the
    // Vietnamese range) is a fourth rule competing with Fontsource's own —
    // and if its src is local(), it can silently substitute an unverified
    // system font for the vendored, checker-verified one. See the comment
    // in fonts.css for the incident this guards against.
    //
    // Match the actual rule shape (`@font-face {`), not the bare substring —
    // the explanatory comment above mentions the term in prose, and a naive
    // `.toContain('@font-face')` would flag that prose as if it were a rule.
    expect(css).not.toMatch(/@font-face\s*\{/);
  });
});

describe('vendored font css (the file that actually reaches the browser)', () => {
  // fonts.css only @imports these; readFileSync does not inline @import, so
  // assertions about cascade behaviour (font-display, unicode-range) must
  // read the real Fontsource files on disk, not fonts.css's own text.
  it('the vendored vietnamese subset sets font-display: swap', () => {
    const proseVn = readFileSync(
      'node_modules/@fontsource/be-vietnam-pro/vietnamese-400.css',
      'utf8',
    );
    const monoVn = readFileSync(
      'node_modules/@fontsource/jetbrains-mono/vietnamese-400.css',
      'utf8',
    );
    expect(proseVn).toContain('font-display: swap');
    expect(monoVn).toContain('font-display: swap');
  });

  // Note: this Fontsource version's per-subset files (vietnamese-400.css,
  // latin-400.css, ...) do not declare a `unicode-range` at all — each file
  // already contains only one subset's glyphs, so there is nothing for the
  // browser to disambiguate within the file. A `unicode-range` assertion
  // against the real files would be false, so it is intentionally not
  // asserted here rather than faked against decorative text.
});
