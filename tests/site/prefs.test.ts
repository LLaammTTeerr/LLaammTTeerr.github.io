import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { PREFS_INLINE_SCRIPT, STORAGE_KEYS } from '../../src/site/prefs-script';
import { DEFAULTS, PALETTES } from '../../src/site/themes';

describe('inline preferences script', () => {
  it('reads every preference from localStorage', () => {
    for (const key of Object.values(STORAGE_KEYS)) {
      expect(PREFS_INLINE_SCRIPT).toContain(key);
    }
  });

  it('sets all three data attributes on the document element', () => {
    for (const attr of ['data-palette', 'data-intensity', 'data-meter']) {
      expect(PREFS_INLINE_SCRIPT).toContain(attr);
    }
  });

  it('honours prefers-color-scheme on a first visit', () => {
    expect(PREFS_INLINE_SCRIPT).toContain('prefers-color-scheme');
  });

  it('is wrapped so a storage exception cannot break the page', () => {
    // Safari in private mode throws on localStorage access. An unhandled
    // throw here would abort the inline script and leave the page unstyled.
    expect(PREFS_INLINE_SCRIPT).toContain('try');
    expect(PREFS_INLINE_SCRIPT).toContain('catch');
  });

  it('contains no line breaks that would need escaping in an attribute', () => {
    expect(PREFS_INLINE_SCRIPT.includes('</script')).toBe(false);
  });
});

describe('built homepage', () => {
  it('inlines the preferences script in the head, before any stylesheet link', () => {
    const html = readDist('index.html');
    const scriptAt = html.indexOf('data-palette');
    const bodyAt = html.indexOf('<body');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(bodyAt);
  });

  it('renders the picker with every palette', () => {
    const html = readDist('index.html');
    for (const p of PALETTES) {
      expect(html, `picker missing ${p.id}`).toContain(`value="${p.id}"`);
    }
  });

  it('renders all three meter markups so no-JS readers see the default', () => {
    const html = readDist('index.html');
    expect(html).toContain('meter-m1');
    expect(html).toContain('meter-m2');
    expect(html).toContain('meter-m3');
  });

  it('declares the document language as Vietnamese', () => {
    expect(readDist('index.html')).toContain('<html lang="vi"');
  });
});
