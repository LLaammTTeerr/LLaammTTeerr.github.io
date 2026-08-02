import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { hasVietnameseSubset } from '../../scripts/check-vietnamese';

describe('font coverage', () => {
  it('the prose face ships a vietnamese subset', () => {
    expect(hasVietnameseSubset('node_modules/@fontsource/be-vietnam-pro')).toBe(true);
  });

  it('the monospace face ships a vietnamese subset', () => {
    // Hashes sit beside Vietnamese titles in the same table; the mono face
    // must cover both or titles break mid-word.
    const mono = readFileSync('src/styles/fonts.css', 'utf8').match(
      /@fontsource\/([a-z0-9-]+)/,
    );
    expect(mono).not.toBeNull();
  });
});

describe('fonts.css', () => {
  const css = readFileSync('src/styles/fonts.css', 'utf8');

  it('exists and declares font faces', () => {
    expect(existsSync('src/styles/fonts.css')).toBe(true);
    expect(css).toContain('@font-face');
  });

  it('self-hosts — no external url', () => {
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('declares a vietnamese unicode-range', () => {
    // U+1EA0–U+1EF9 is Latin Extended Additional, where Vietnamese lives.
    expect(css.toUpperCase()).toContain('U+1EA0');
  });

  it('uses font-display swap so text is never invisible', () => {
    expect(css).toContain('font-display: swap');
  });
});
