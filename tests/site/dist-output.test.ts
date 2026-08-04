import { describe, it, expect } from 'vitest';
import { OFF_ORIGIN, cssPerPage, distPages, distScripts, readDist, readDistCss, withoutAnchorHrefs, withoutNamespaceUris } from './dist';
import { parseRules, selectorParts, declaredValue, stripComments } from './css';
import { METERS, DEFAULTS } from '../../src/site/themes';
import { getBlocks, splitHashWork } from '../../src/site/chain-data';

// Guards over what the build actually ships. Each of these covers a property
// the branch claims but nothing else asserts: that a page load touches no
// third party, that the vendored Vietnamese fonts reach `dist`, that the
// component stylesheets reach `dist`, and that exactly one work meter is
// visible at a time.

describe('no external requests', () => {
  // Not a style preference: §9 requires a page load touch no third party. A
  // CDN font, an analytics tag or an external stylesheet would all show up
  // here.
  //
  // Every page, not just the homepage. Scoped to `index.html`, this guard was
  // blind to the one route that vendored a third-party library: adding a CDN
  // stylesheet and a tracking pixel to `[slug].astro` shipped both to
  // `dist/tx/…/index.html` with all 145 site tests green.
  it('finds more than one page to check', () => {
    // Anti-vacuity: a loop over an empty or single-page list would pass while
    // asserting nothing about the routes added since.
    expect(distPages().length).toBeGreaterThan(1);
    expect(distPages()).toContain('index.html');
  });

  it('the guard pattern catches a protocol-relative url, not only an absolute one', () => {
    // Anti-vacuity for the widening itself, and it is the assertion that would
    // have caught the hole: `//example.com/beacon.js` is a real cross-origin
    // request — the browser supplies the page's own scheme — and the previous
    // `/https?:\/\//` walked straight past it. Pinned here rather than only
    // implied by the loops below, because a loop over honest output cannot
    // tell a strong pattern from a weak one.
    expect(OFF_ORIGIN.test('//example.com/beacon.js')).toBe(true);
    expect(OFF_ORIGIN.test('https://example.com/x')).toBe(true);
    expect(OFF_ORIGIN.test('http://example.com/x')).toBe(true);
    // …and does not fire on the two things that legitimately carry `//`: a
    // same-origin path, and the base64 font payloads every stylesheet ships.
    expect(OFF_ORIGIN.test('/chain.json')).toBe(false);
    expect(OFF_ORIGIN.test('url(data:font/woff2;base64,A//A/evkhSpkOMDA9VTmwAV)')).toBe(false);
  });

  it('no built page references an absolute or protocol-relative url', () => {
    // `withoutAnchorHrefs` first: `/about` links real placeholder urls in
    // `<a href>` (src/site/profile.ts), which a reader may choose to follow
    // but which no page *load* fetches — see its own doc comment for why
    // that is not the hazard this guard exists to catch.
    for (const page of distPages()) {
      expect(
        withoutNamespaceUris(withoutAnchorHrefs(readDist(page))),
        `${page} makes a third-party request`,
      ).not.toMatch(OFF_ORIGIN);
    }
  });

  it('finds the scripts the build emits, so the next assertion is not vacuous', () => {
    // Anti-vacuity, and it earns its place: this guard was blind to scripts
    // entirely until the site shipped one, and a loop over an empty map would
    // go on passing the moment a bundle stopped being emitted.
    expect(distScripts().size).toBeGreaterThan(0);
  });

  it('no script the build emits references an absolute or protocol-relative url', () => {
    // The hole this closes was measured, not imagined: the verifier island's
    // `fetch` was pointed at `https://example.com` and every test stayed green,
    // because nothing read the bundle. A script is the easiest place to reach a
    // third party, not the hardest — it can do it conditionally, after load.
    //
    // And measured a second time, after this guard existed: a reviewer added
    // `void fetch('//example.com/beacon.js')` *beside* the honest fetch — a
    // working beacon on every `/verify` load — and it shipped into `dist` with
    // all 133 guard tests green. Replacing the honest fetch trips an unrelated
    // assertion; adding one tripped nothing. A guard that only fires when the
    // attacker also removes the honest behaviour is not a guard.
    for (const [file, source] of distScripts()) {
      expect(source, `${file} makes a third-party request`).not.toMatch(OFF_ORIGIN);
    }
  });

  it('no stylesheet any built page loads references an absolute or protocol-relative url', () => {
    for (const [page, css] of cssPerPage()) {
      expect(css, `css loaded by ${page} makes a third-party request`).not.toMatch(OFF_ORIGIN);
    }
  });

  it('excuses xml namespace identifiers, and nothing else', () => {
    // The carry note this guard had to satisfy: a post containing `$O(n)$`
    // gains `xmlns="http://www.w3.org/1998/Math/MathML"` from KaTeX, which is
    // an inert identifier, not a fetch. Excluding it must not open a hole —
    // so this pins both halves rather than loosening the pattern.
    const mathml = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>n</mi></math>';
    expect(withoutNamespaceUris(mathml)).not.toMatch(/https?:\/\//);

    for (const real of [
      '<link rel="stylesheet" href="https://cdn.evil.example.com/tracker.css" />',
      '<img src="https://tracker.example.com/pixel.gif" alt="" />',
      '<use xlink:href="https://evil.example.com/sprite.svg#i" />',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example.com/x.png" /></svg>',
    ]) {
      expect(withoutNamespaceUris(real), `${real} was excused as a namespace`).toMatch(/https?:\/\//);
    }
  });

  it('excuses an anchor href, and nothing else that carries the same url', () => {
    const anchor = '<a href="https://github.com/your-handle">GitHub</a>';
    expect(withoutAnchorHrefs(anchor)).not.toMatch(/https?:\/\//);
    // The text of the link survives — only the attribute value is stripped.
    expect(withoutAnchorHrefs(anchor)).toContain('>GitHub</a>');

    for (const real of [
      '<link rel="stylesheet" href="https://cdn.evil.example.com/tracker.css" />',
      '<img src="https://tracker.example.com/pixel.gif" alt="" />',
      '<script src="https://evil.example.com/x.js"></script>',
      // Two anchors on one line: the non-greedy-looking `[^>]*` must not
      // reach past the first tag's own `>` into the second's attributes.
      '<a href="/local">local</a><img src="https://tracker.example.com/pixel.gif" />',
    ]) {
      expect(withoutAnchorHrefs(real), `${real} was excused as an anchor`).toMatch(/https?:\/\//);
    }
  });
});

describe('fonts reach the build', () => {
  const faces = () => [...stripComments(readDistCss()).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);

  it('ships a @font-face for both families', () => {
    const all = faces();
    expect(all.length, 'no @font-face in the built css at all').toBeGreaterThan(0);
    for (const family of ['Be Vietnam Pro', 'JetBrains Mono']) {
      expect(
        all.some((f) => new RegExp(`font-family:\\s*["']?${family}`).test(f)),
        `built css declares no @font-face for ${family}`,
      ).toBe(true);
    }
  });

  it('ships a vietnamese subset for both families', () => {
    // Deleting `import '../styles/fonts.css'` from Base.astro used to leave
    // every font test green while the site rendered Vietnamese in whatever
    // the system happened to provide. This is the assertion that notices.
    for (const family of ['Be Vietnam Pro', 'JetBrains Mono']) {
      const vietnamese = faces().filter(
        (f) => new RegExp(`font-family:\\s*["']?${family}`).test(f) && /vietnamese/i.test(f),
      );
      expect(vietnamese.length, `no vietnamese @font-face for ${family} in the built css`).toBeGreaterThan(0);
    }
  });
});

describe('hash display', () => {
  // §9's "Type" rule: every hash is middle-truncated. A raw 64-hex hash or
  // merkle root in the built page would mean BlockCard rendered the field
  // directly instead of through `shortHash`.
  it('middle-truncates every block hash and merkle root', () => {
    const html = readDist('index.html');
    for (const block of getBlocks()) {
      expect(html, `full hash of block #${block.height} appears untruncated`).not.toContain(
        block.hash,
      );
      expect(
        html,
        `full merkle root of block #${block.height} appears untruncated`,
      ).not.toContain(block.merkleRoot);
    }
  });

  it("highlights each block's proven leading zeros", () => {
    const html = readDist('index.html');
    for (const block of getBlocks()) {
      const work = splitHashWork(block.shortHash, block.difficulty);
      expect(work.zeros.length, `block #${block.height} has difficulty 0`).toBeGreaterThan(0);
      expect(
        html,
        `block #${block.height}'s proven zeros "${work.zeros}" are not marked up`,
      ).toContain(`<mark class="zeros">${work.zeros}</mark>`);
    }
  });
});

describe('component styles reach the build', () => {
  it('ships the rules for every component the homepage renders', () => {
    // chain.css is imported by StatsBar, BlockCard and WorkMeter rather than
    // by the page, so that a future route cannot render them unstyled by
    // forgetting an import. This checks the rules actually arrive.
    const css = readDistCss();
    for (const selector of ['.stat', '.card', '.work', '.meter']) {
      expect(
        parseRules(css).some((r) => selectorParts(r).some((p) => p.split(/\s+/).includes(selector))),
        `built css has no rule for ${selector}`,
      ).toBe(true);
    }
  });
});

/**
 * All three meter markups are always rendered; CSS picks one. Nothing tested
 * that selection, so deleting a single `display: none` rule would show two
 * meters at once with a fully green suite.
 *
 * This evaluates the cascade for the meter container itself over the built
 * CSS: the rules that select `.meter` / `.meter-mN` (optionally under
 * `:root` or `[data-meter="…"]`), resolved by specificity then source order.
 * What it models: those selector shapes, specificity, source order, and the
 * UA default of `display: block` when no rule matches. What it does not
 * model: media queries (it refuses to run if a meter-visibility rule sits
 * inside one), `!important`, inline styles, and any selector shape outside
 * the grammar below — which it also refuses rather than silently skips.
 */
// Quotes optional: the built CSS is minified, so `[data-meter="m2"]` ships
// as `[data-meter=m2]`.
const CONTAINER = /^(?:\[data-meter=["']?([a-z0-9-]+)["']?\]\s+|(:root)\s+)?\.meter(?:-([a-z0-9-]+))?$/;

interface VisibilityRule {
  /** Required `data-meter` value on the root, or null for any. */
  context: string | null;
  /** Meter id this rule targets, or null for every `.meter`. */
  target: string | null;
  display: string;
  specificity: number;
  order: number;
}

function visibilityRules(css: string): VisibilityRule[] {
  const out: VisibilityRule[] = [];
  for (const rule of parseRules(css)) {
    for (const part of selectorParts(rule)) {
      if (!/\.meter(-|\s|$)/.test(part)) continue;
      const m = CONTAINER.exec(part);
      if (!m) continue; // targets a descendant (`.meter .segs`), not the container
      const display = declaredValue(rule.body, 'display');
      if (display === null) continue;
      if (rule.atRule !== null) {
        throw new Error(
          `meter visibility rule "${part}" sits inside ${rule.atRule}; this evaluator does not model at-rules`,
        );
      }
      out.push({
        context: m[1] ?? null,
        target: m[3] ?? null,
        display,
        // Attribute selectors and pseudo-classes both count in the class column.
        specificity: (part.match(/\.|\[|:/g) ?? []).length,
        order: rule.order,
      });
    }
  }
  return out;
}

/** Resolved `display` of `.meter .meter-{id}` under `<html data-meter={context}>`. */
function displayOf(rules: VisibilityRule[], context: string | null, id: string): string {
  const winner = rules
    .filter((r) => (r.context === null || r.context === context) && (r.target === null || r.target === id))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order)
    .pop();
  return winner?.display ?? 'block'; // no rule matched: the UA default wins
}

describe('exactly one work meter is visible', () => {
  const ids = METERS.map((m) => m.id);

  it('finds the meter visibility rules in the built css', () => {
    expect(visibilityRules(readDistCss()).length).toBeGreaterThan(0);
  });

  it('shows only the selected meter for each preference', () => {
    const rules = visibilityRules(readDistCss());
    for (const selected of ids) {
      const visible = ids.filter((id) => displayOf(rules, selected, id) !== 'none');
      expect(visible, `data-meter="${selected}" should show exactly that meter`).toEqual([selected]);
    }
  });

  it('shows only the default meter with no preference attribute set', () => {
    // The no-JS and first-paint case: nothing has written data-meter yet.
    const rules = visibilityRules(readDistCss());
    const visible = ids.filter((id) => displayOf(rules, null, id) !== 'none');
    expect(visible).toEqual([DEFAULTS.meter]);
  });
});
