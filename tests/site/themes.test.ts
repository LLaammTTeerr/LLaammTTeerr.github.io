import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PALETTES, INTENSITIES, METERS, DEFAULTS } from '../../src/site/themes';

const CSS = readFileSync('src/styles/tokens.css', 'utf8');

describe('palette catalogue', () => {
  it('offers eleven palettes', () => {
    expect(PALETTES).toHaveLength(11);
  });

  it('has unique ids', () => {
    const ids = PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes both light and dark options', () => {
    expect(PALETTES.some((p) => p.dark)).toBe(true);
    expect(PALETTES.some((p) => !p.dark)).toBe(true);
  });

  it('gives every palette two swatch colours for the picker', () => {
    for (const p of PALETTES) {
      expect(p.swatch).toHaveLength(2);
      for (const c of p.swatch) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('css agreement', () => {
  it('defines a selector for every palette id', () => {
    for (const p of PALETTES) {
      expect(CSS, `missing palette ${p.id}`).toContain(`[data-palette="${p.id}"]`);
    }
  });

  it('defines a selector for every non-default intensity', () => {
    for (const i of INTENSITIES) {
      if (i.id === DEFAULTS.intensity) continue;
      expect(CSS, `missing intensity ${i.id}`).toContain(`[data-intensity="${i.id}"]`);
    }
  });

  it('defines a selector for every meter id', () => {
    for (const m of METERS) {
      expect(CSS, `missing meter ${m.id}`).toContain(`[data-meter="${m.id}"]`);
    }
  });

  it('sets the base token block on :root so the default palette needs no attribute', () => {
    expect(CSS).toMatch(/:root\s*\{/);
  });
});

describe('defaults', () => {
  it('names a palette that exists', () => {
    expect(PALETTES.map((p) => p.id)).toContain(DEFAULTS.palette);
  });

  it('names an intensity and meter that exist', () => {
    expect(INTENSITIES.map((i) => i.id)).toContain(DEFAULTS.intensity);
    expect(METERS.map((m) => m.id)).toContain(DEFAULTS.meter);
  });

  it('defaults to github-dark, minimal, bar per spec §9.1', () => {
    expect(DEFAULTS).toEqual({ palette: 'github-dark', intensity: 'min', meter: 'm1' });
  });
});
