import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PALETTES, INTENSITIES, METERS, DEFAULTS } from '../../src/site/themes';
import { hasSelectorContaining, propsDeclaredBy as propsFor } from './css';

const CSS = readFileSync('src/styles/tokens.css', 'utf8');

/**
 * True when some *rule* selects on `attr`. Not `CSS.toContain(...)`: this
 * file's header comment names `[data-palette="github-dark"]` in prose, so a
 * bare substring assertion can be satisfied by a comment rather than by a
 * rule. `hasSelectorContaining` parses the stylesheet with comments removed.
 */
function declaresSelector(attr: string): boolean {
  return hasSelectorContaining(CSS, attr);
}

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

/** Custom property names (`--foo`) declared by rules whose selector is
 * exactly `selector`. */
function propsDeclaredBy(selector: string): Set<string> {
  return propsFor(CSS, selector);
}

describe('css agreement', () => {
  it('defines a selector for every non-default palette id', () => {
    // github-dark (DEFAULTS.palette) is intentionally absent here: it lives
    // on :root, unattributed, so it applies with no stored preference and no
    // JavaScript. A [data-palette="github-dark"] block would just duplicate
    // :root verbatim with nothing to keep the two in sync — see the
    // ":root carries the full default token set" test below for the check
    // that actually guards the default.
    for (const p of PALETTES) {
      if (p.id === DEFAULTS.palette) continue;
      expect(declaresSelector(`[data-palette="${p.id}"]`), `missing palette ${p.id}`).toBe(true);
    }
  });

  it('defines a selector for every non-default intensity', () => {
    for (const i of INTENSITIES) {
      if (i.id === DEFAULTS.intensity) continue;
      expect(declaresSelector(`[data-intensity="${i.id}"]`), `missing intensity ${i.id}`).toBe(true);
    }
  });

  it('defines a selector for every meter id', () => {
    for (const m of METERS) {
      expect(declaresSelector(`[data-meter="${m.id}"]`), `missing meter ${m.id}`).toBe(true);
    }
  });

  it('sets the base token block on :root so the default palette needs no attribute', () => {
    expect(CSS).toMatch(/:root\s*\{/);
  });

  it(':root carries the full default token set — every property a non-default palette defines also exists on :root', () => {
    const rootProps = propsDeclaredBy(':root');
    expect(rootProps.size, 'no custom properties found on :root — check the CSS parses').toBeGreaterThan(0);
    for (const p of PALETTES) {
      if (p.id === DEFAULTS.palette) continue;
      const paletteProps = propsDeclaredBy(`[data-palette="${p.id}"]`);
      // Without this, a palette whose block failed to parse contributes an
      // empty set and passes the subset check below having checked nothing.
      expect(paletteProps.size, `no custom properties found for palette ${p.id}`).toBeGreaterThan(0);
      for (const prop of paletteProps) {
        expect(rootProps, `:root is missing ${prop}, defined by palette ${p.id}`).toContain(prop);
      }
    }
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
