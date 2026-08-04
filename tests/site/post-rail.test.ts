import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cssPerPage, pageScripts, readDist } from './dist';
import {
  declaredValue,
  mediaWidthMatches,
  parseRules,
  resolveProperty,
  selectorParts,
  stripComments,
  type StyledElement,
} from './css';
import { getPosts } from '../../src/site/chain-data';
import { readingProgressState, watchReadingProgress } from '../../src/site/reading-progress';

/**
 * §6.1 (revised 2026-08-04) — the transaction panel is a sticky rail beside the
 * article, the article carries its own card, and a reading-progress indicator
 * measures *the article's* extent.
 *
 * Everything about the layout is asserted by **resolving a property through the
 * whole cascade of the built stylesheets**, at a stated viewport width, and
 * never by looking for a rule in a file. The one layout defect this repository
 * has actually shipped was a cascade outcome — `base.css`'s `.nav ul` beating
 * `.search-list` — where every declaration involved was present and correct in
 * its own file. `resolveProperty` is what can see that, and §6.1 puts the
 * panel's `dl` in exactly the same position: `chain.css` says `.meta` is two
 * columns, and the rail has to win.
 */

const slug = (): string => getPosts()[0]!.slug!;

/** Every stylesheet the built post page loads, concatenated in load order. */
function postCss(): string {
  const page = `tx/${slug()}/index.html`;
  const css = cssPerPage().get(page);
  if (css === undefined) throw new Error(`${page} is not in the build`);
  return css;
}

/** The two widths §6.1 names: one on each side of the 62rem breakpoint. */
const WIDE = 70;
const NARROW = 50;

const BODY: StyledElement = { tag: 'body' };
const MAIN: StyledElement = { tag: 'main' };
const LAYOUT: StyledElement = { tag: 'div', classes: ['post-layout'] };
const COL: StyledElement = { tag: 'div', classes: ['post-col'] };
const ARTICLE: StyledElement = { tag: 'article', classes: ['post', 'card'] };
const RAIL: StyledElement = { tag: 'aside', classes: ['post-rail'] };
const PANEL: StyledElement = { tag: 'div', classes: ['txpanel'] };
const META: StyledElement = { tag: 'dl', classes: ['meta'] };
const VERIFIER: StyledElement = { tag: 'section', id: 'txv', classes: ['card', 'vfy', 'txv'] };
const FILL: StyledElement = { tag: 'i' };

const bar = (on: boolean): StyledElement => ({
  tag: 'div',
  classes: ['post-progress'],
  attrs: { 'data-on': on ? 'true' : 'false' },
});

const chain = {
  layout: [BODY, MAIN, LAYOUT],
  col: [BODY, MAIN, LAYOUT, COL],
  article: [BODY, MAIN, LAYOUT, COL, ARTICLE],
  rail: [BODY, MAIN, LAYOUT, RAIL],
  panel: [BODY, MAIN, LAYOUT, RAIL, PANEL],
  meta: [BODY, MAIN, LAYOUT, RAIL, PANEL, META],
  verifier: [BODY, MAIN, LAYOUT, COL, VERIFIER],
  fill: (on: boolean): StyledElement[] => [BODY, MAIN, LAYOUT, COL, ARTICLE, bar(on), FILL],
};

describe('the media-query evaluator the layout assertions rest on', () => {
  // Anti-vacuity for the evaluator itself. Every assertion in this file that
  // names a width is worthless if `mediaWidthMatches` answers `null` for the
  // queries this build actually emits — `resolveProperty` would then throw, and
  // a test that throws is a test that was never run against the real cascade.
  it('reads both the source spelling and the range spelling the minifier emits', () => {
    expect(mediaWidthMatches('@media (min-width: 62rem)', 70)).toBe(true);
    expect(mediaWidthMatches('@media (min-width: 62rem)', 50)).toBe(false);
    expect(mediaWidthMatches('@media (width>=62rem)', 70)).toBe(true);
    expect(mediaWidthMatches('@media (width>=62rem)', 50)).toBe(false);
    expect(mediaWidthMatches('@media (width<=44rem)', 30)).toBe(true);
    expect(mediaWidthMatches('@media (width<=44rem)', 70)).toBe(false);
    // The boundary itself: 62rem is wide enough for the rail, by §6.1's
    // "below 62rem the rail collapses".
    expect(mediaWidthMatches('@media (min-width: 62rem)', 62)).toBe(true);
    expect(mediaWidthMatches('@media (width<=44rem)', 44)).toBe(true);
    // px, converted against a 16px root.
    expect(mediaWidthMatches('@media (min-width: 992px)', 62)).toBe(true);
    expect(mediaWidthMatches('@media (min-width: 993px)', 62)).toBe(false);
  });

  it('refuses what it cannot evaluate rather than guessing', () => {
    expect(mediaWidthMatches('@media (prefers-reduced-motion: reduce)', 70)).toBeNull();
    expect(mediaWidthMatches('@media (min-width: 20rem), print', 70)).toBeNull();
    expect(mediaWidthMatches('@supports (animation-timeline: view())', 70)).toBeNull();
    expect(mediaWidthMatches('@media (orientation: landscape)', 70)).toBeNull();
  });

  it('still refuses an at-rule when resolveProperty is given no width', () => {
    const css = '@media (min-width: 62rem) { .post-rail { position: sticky } }';
    expect(() => resolveProperty(css, [RAIL], 'position')).toThrow();
    expect(resolveProperty(css, [RAIL], 'position', { widthRem: WIDE })).toBe('sticky');
    expect(resolveProperty(css, [RAIL], 'position', { widthRem: NARROW })).toBeNull();
  });

  it('refuses an unmodelled selector for this element, and not for its namesake', () => {
    // The refusal is what makes every `null` below mean something, so it has to
    // still fire — and it has to fire on the right rule. `.txv-run` is the
    // button *inside* `<section class="card vfy txv">`, and a substring test
    // read it as a rule about the section, which made "the article, the panel
    // and the verifier draw the same card" unaskable.
    const own = '.txv:hover { background: red }';
    expect(() => resolveProperty(own, [VERIFIER], 'background', { widthRem: WIDE })).toThrow();
    const neighbour = '.txv-run:hover:not(:disabled) { background: red }';
    expect(resolveProperty(neighbour, [VERIFIER], 'background', { widthRem: WIDE })).toBeNull();
    // …and a chain that really carries the longer class is refused again.
    const button: StyledElement = { tag: 'button', classes: ['txv-run'] };
    expect(() => resolveProperty(neighbour, [button], 'background', { widthRem: WIDE })).toThrow();
  });

  it("finds the post page's stylesheets at all", () => {
    // Anti-vacuity: `cssPerPage()` returning an empty string would make every
    // resolution below `null`, and several of them assert exactly that.
    expect(postCss().length).toBeGreaterThan(1000);
    expect(stripComments(postCss())).toContain('.post-layout');
  });
});

describe('the post page is two columns above 62rem', () => {
  it('lays the article and the rail out side by side', () => {
    const css = postCss();
    expect(resolveProperty(css, chain.layout, 'display', { widthRem: WIDE })).toBe('grid');
    const columns = resolveProperty(css, chain.layout, 'grid-template-columns', {
      widthRem: WIDE,
    });
    // The article keeps the measure it already had; the rail takes the rest of
    // the width `main` allows, which is what §6.1's "the space is spent" means.
    expect(columns, 'the article column is no longer the 38rem measure').toContain('38rem');
    expect(columns, 'the rail column does not absorb the remaining width').toContain('1fr');
  });

  it('makes the rail sticky, so the hash stays on screen while the article is read', () => {
    const css = postCss();
    expect(resolveProperty(css, chain.rail, 'position', { widthRem: WIDE })).toBe('sticky');
    // A sticky element with no offset never sticks to anything.
    expect(resolveProperty(css, chain.rail, 'top', { widthRem: WIDE })).not.toBeNull();
    // Anchored to the top of the column and not stretched down it: a rail that
    // stretches is a rail whose own top scrolls out of view with the article.
    expect(resolveProperty(css, chain.layout, 'align-items', { widthRem: WIDE })).toBe('start');
  });

  it('lets a grid column narrower than its widest code block still shrink', () => {
    // The post page is the one route with `<pre>` and KaTeX in it, and a grid
    // track's automatic minimum is `min-content` — a long unwrapped code line
    // would push the article column past 38rem and squeeze the rail out of the
    // viewport. Both the track and the card have to say they may shrink.
    const css = postCss();
    expect(resolveProperty(css, chain.layout, 'grid-template-columns', { widthRem: WIDE }))
      .toContain('minmax(0');
    expect(resolveProperty(css, chain.col, 'min-width', { widthRem: WIDE })).toBe('0');
    expect(resolveProperty(css, chain.article, 'min-width', { widthRem: WIDE })).toBe('0');
    // …and the code block itself still scrolls rather than overflowing.
    expect(
      resolveProperty(css, [...chain.article, { tag: 'pre' }], 'overflow-x', { widthRem: WIDE }),
    ).toBe('auto');
  });

  it("stacks the panel's metadata: a 64-character hash cannot share a row with its label", () => {
    // The collision this file exists for. `chain.css` says
    // `.meta { grid-template-columns: 4.2rem 1fr }` at (0,1,0); inside a rail
    // about 20rem wide that leaves under 16rem for a 66-character hash. The
    // rail's own rule has to win the cascade — which is a fact about the
    // cascade, not about either file.
    const css = postCss();
    // `minmax(0, …)` and not a bare `1fr`: a `1fr` track's automatic minimum is
    // min-content, so one value that will not wrap sizes the whole column.
    expect(resolveProperty(css, chain.meta, 'grid-template-columns', { widthRem: WIDE })).toBe(
      'minmax(0,1fr)',
    );
    // Below the breakpoint the panel is a full-width band again, where the
    // label column fits and is easier to scan.
    expect(resolveProperty(css, chain.meta, 'grid-template-columns', { widthRem: NARROW })).toBe(
      '4.2rem 1fr',
    );
    // …and **both** spellings of a hash must wrap inside it. This is the one
    // the suite missed and a browser found: `.hash` has broken anywhere since
    // it was written, `.a-hash` — the same 66 characters under a pending
    // transaction — declared only a colour, and in a 20rem rail it pushed the
    // `dl` to 469px inside a 313px column and gave the rail a horizontal
    // scrollbar. Every post published into the open block renders that one.
    for (const kind of ['hash', 'a-hash']) {
      expect(
        resolveProperty(css, [...chain.meta, { tag: 'span', classes: [kind] }], 'word-break', {
          widthRem: WIDE,
        }),
        `a ${kind} in the rail cannot wrap`,
      ).toBe('break-all');
    }
  });
});

describe('below 62rem the rail collapses and the panel returns above the article', () => {
  it('stacks the two columns', () => {
    const css = postCss();
    expect(resolveProperty(css, chain.layout, 'display', { widthRem: NARROW })).toBe('flex');
    expect(resolveProperty(css, chain.layout, 'flex-direction', { widthRem: NARROW })).toBe(
      'column',
    );
  });

  it('puts the panel first, and does not leave it first when the rail comes back', () => {
    // The article is first in the document — a screen reader should reach the
    // title and the prose before a 64-character hash — so the collapsed layout
    // has to hoist the panel visually, and the wide layout has to put it back.
    // Both halves, because an `order` that is never reset is a rail rendered
    // above the article at every width.
    const css = postCss();
    expect(resolveProperty(css, chain.rail, 'order', { widthRem: NARROW })).toBe('-1');
    expect(resolveProperty(css, chain.rail, 'order', { widthRem: WIDE })).toBe('0');
  });

  it('is not sticky, and holds the whole page to one aligned column', () => {
    const css = postCss();
    expect(resolveProperty(css, chain.rail, 'position', { widthRem: NARROW })).toBeNull();
    // §6.1's complaint about the old layout was that the article "floated
    // narrow between two wider blocks". Collapsed, the panel, the article and
    // the verifier share one column of the article's own measure.
    expect(resolveProperty(css, chain.layout, 'max-width', { widthRem: NARROW })).toBe('38rem');
    expect(resolveProperty(css, chain.layout, 'max-width', { widthRem: WIDE })).not.toBe('38rem');
  });
});

describe('the article is a card, in the same visual language as the panel', () => {
  it('draws the same surface, border and radius as the panel and the verifier', () => {
    const css = postCss();
    for (const property of ['background', 'border', 'border-radius']) {
      const article = resolveProperty(css, chain.article, property, { widthRem: WIDE });
      expect(article, `the article declares no ${property} — it is not a card`).not.toBeNull();
      expect(
        resolveProperty(css, chain.panel, property, { widthRem: WIDE }),
        `the panel's ${property} differs from the article's`,
      ).toBe(article);
      expect(
        resolveProperty(css, chain.verifier, property, { widthRem: WIDE }),
        `the verification control's ${property} differs from the article's`,
      ).toBe(article);
    }
  });

  it('takes every colour from a token, never a literal', () => {
    // Eleven reader-selectable palettes. A literal would be wrong under ten.
    const css = postCss();
    for (const property of ['background', 'border']) {
      const value = resolveProperty(css, chain.article, property, { widthRem: WIDE })!;
      expect(value, `the article's ${property} hard-codes a colour`).toContain('var(--');
    }
  });

  it('keeps the reading measure inside the card', () => {
    // A card is padding, and padding eats the measure. The column is 38rem, so
    // the text is narrower than that — but it must stay long-form prose rather
    // than a 65-character column squeezed to 50.
    const css = postCss();
    const padding = resolveProperty(css, chain.article, 'padding', { widthRem: WIDE });
    expect(padding, 'the article card has no padding of its own').not.toBeNull();
    // The shorthand's inline side: the second value, or the only one.
    const sides = padding!.trim().split(/\s+/);
    const inline = /^([\d.]+)rem$/.exec(sides[1] ?? sides[0]!);
    expect(inline, `the card's inline padding is not a rem figure: ${padding!}`).not.toBeNull();
    // 38rem of column less two of these has to leave at least 33rem of text,
    // which at the body's 1.02rem is comfortably inside §6.1's 65–75 characters.
    expect(38 - 2 * Number(inline![1]), 'the card padding ate the reading measure').toBeGreaterThan(
      33,
    );
  });
});

describe('the reading-progress indicator', () => {
  it("is driven by the article's own view timeline, and nothing else", () => {
    const css = postCss();
    // Exactly one element declares the timeline, and it is the article. A
    // timeline declared on `main`, on `body` or on the layout wrapper is the
    // document-scoped bar §6.1 names as the defect: it counts the header, the
    // panel and the footer, and reads complete while the article has text left.
    const declarations = parseRules(stripComments(css)).filter(
      (rule) => declaredValue(rule.body, 'view-timeline-name') !== null,
    );
    expect(declarations.length, 'no element declares a view timeline at all').toBe(1);
    expect(selectorParts(declarations[0]!)).toEqual(['article.post']);
    const name = declaredValue(declarations[0]!.body, 'view-timeline-name')!;
    expect(name.startsWith('--'), `${name} is not a custom timeline name`).toBe(true);

    // …and the bar's fill is animated by that timeline, over the range in which
    // the article covers the viewport.
    expect(resolveProperty(css, chain.fill(true), 'animation-timeline', { widthRem: WIDE })).toBe(
      name,
    );
    expect(resolveProperty(css, chain.fill(true), 'animation-range', { widthRem: WIDE })).toBe(
      'contain',
    );
  });

  it('animates a transform, and names keyframes the stylesheet actually defines', () => {
    const css = postCss();
    const animation = resolveProperty(css, chain.fill(true), 'animation-name', {
      widthRem: WIDE,
    });
    expect(animation, 'the fill is not animated at all').not.toBeNull();
    // The `animation` shorthand resets `animation-timeline`; longhands cannot.
    expect(stripComments(css)).toContain(`@keyframes ${animation!}`);
    expect(resolveProperty(css, chain.fill(true), 'transform', { widthRem: WIDE })).toContain(
      'scaleX',
    );
    expect(resolveProperty(css, chain.fill(true), 'transform-origin', { widthRem: WIDE })).not
      .toBeNull();
  });

  it('does not animate at all when the article is shorter than the viewport', () => {
    // "A progress bar for something with no progress is noise." The gate is an
    // attribute, so the whole difference is in the cascade.
    const css = postCss();
    expect(resolveProperty(css, chain.fill(false), 'animation-timeline', { widthRem: WIDE }))
      .toBeNull();
    expect(resolveProperty(css, chain.fill(false), 'animation-name', { widthRem: WIDE }))
      .toBeNull();
    // …and with no animation the fill is a zero-width bar, not a full one:
    // this is also what a browser with no scroll-driven animations renders.
    expect(resolveProperty(css, chain.fill(false), 'transform', { widthRem: WIDE })).toBe(
      'scaleX(0)',
    );
  });

  it('stays on screen while the article is read', () => {
    const css = postCss();
    expect(resolveProperty(css, [...chain.article, bar(true)], 'position', { widthRem: WIDE })).toBe(
      'sticky',
    );
    expect(resolveProperty(css, [...chain.article, bar(true)], 'top', { widthRem: WIDE })).toBe('0');
    // Both widths: below 62rem the rail is gone and this is the only thing left
    // that could show progress, so it must not be the rail's passenger.
    expect(
      resolveProperty(css, [...chain.article, bar(true)], 'position', { widthRem: NARROW }),
    ).toBe('sticky');
  });

  it('is decorative, and is not announced as content', () => {
    const html = readDist(`tx/${slug()}/index.html`);
    const found = /<div class="post-progress"[^>]*>/.exec(html);
    expect(found, 'the post page renders no progress indicator').not.toBeNull();
    expect(found![0], 'the indicator is exposed to assistive technology').toContain(
      'aria-hidden="true"',
    );
    // No text, no role, nothing to read out — the element is a painted bar.
    expect(/<div class="post-progress"[^>]*>\s*<i><\/i>\s*<\/div>/.test(html)).toBe(true);
  });
});

describe('the indicator is CSS-driven, and does not fight the browser', () => {
  it('adds no scroll listener to the post page', () => {
    // §6.1's indicator is a scroll-driven *animation*; the only JavaScript is
    // the one measurement that decides whether there is any progress to show.
    // A scroll handler on every post page is the cost this site is built to
    // avoid, and a handler that runs per scroll event fights the compositor.
    const { code, sources } = pageScripts(`tx/${slug()}/index.html`);
    expect(sources.length, 'the post page loads no scripts at all to check').toBeGreaterThan(0);
    // Anti-vacuity, and it earns its place: Astro inlines a module script under
    // its size threshold, so the indicator's own script is in the *document* and
    // in none of the `_astro/*.js` files. Scanning only the bundles reported
    // clean on a version of this module that did add a scroll listener.
    expect(code, "the indicator's own script is not in what was scanned").toContain(
      'post-progress',
    );
    expect(code, 'the post page listens for scroll events').not.toMatch(
      /addEventListener\(\s*["'`]scroll/,
    );
    expect(code, 'the post page polls the scroll position').not.toMatch(/\bonscroll\b/);
  });

  it('reads no clock (§14)', () => {
    for (const file of ['src/site/reading-progress.ts', 'src/pages/tx/[slug].astro']) {
      expect(readFileSync(file, 'utf8'), `${file} reads the clock`).not.toMatch(
        /new Date\(\)|Date\.now\(\)/,
      );
    }
  });
});

describe('deciding whether there is any progress to show', () => {
  it('shows the indicator only when the article is taller than the viewport', () => {
    expect(readingProgressState({ articleHeight: 4000, viewportHeight: 900 })).toBe('true');
    expect(readingProgressState({ articleHeight: 901, viewportHeight: 900 })).toBe('true');
    // Exactly one viewport tall is a page with nothing below the fold.
    expect(readingProgressState({ articleHeight: 900, viewportHeight: 900 })).toBe('false');
    expect(readingProgressState({ articleHeight: 400, viewportHeight: 900 })).toBe('false');
    // A viewport of zero height is a measurement taken before layout, not an
    // article with infinite progress.
    expect(readingProgressState({ articleHeight: 400, viewportHeight: 0 })).toBe('false');
  });

  it('measures on load and re-measures when the viewport changes', () => {
    const view = fakeView({ articleHeight: 500, viewportHeight: 900 });
    const stop = watchReadingProgress(view.doc, view.win);
    expect(view.bar.dataset.on, 'nothing was decided on load').toBe('false');

    // A rotation, or a window drag: the article is now taller than the viewport.
    view.resize(400);
    view.fire('resize');
    expect(view.bar.dataset.on, 'the decision was never revisited').toBe('true');

    // …and the listener is the only one, on the one event.
    expect(view.listeners.map((l) => l.type)).toEqual(['resize']);
    stop();
    expect(view.listeners.length, 'the listener was not removable').toBe(0);
  });

  it('does nothing at all on a page with no article or no indicator', () => {
    const missing = fakeView({ articleHeight: 5000, viewportHeight: 900, empty: true });
    expect(() => watchReadingProgress(missing.doc, missing.win)()).not.toThrow();
    expect(missing.listeners.length, 'a page with no article still bound a listener').toBe(0);
  });
});

/**
 * The smallest document `watchReadingProgress` can be driven against: one
 * article with a height, one indicator with a dataset, and a window that
 * records what was bound to it.
 *
 * A shim rather than a headless browser, on the same trade `fake-dom.ts`
 * records: this pins the decision and the wiring, and says nothing about
 * layout. That the real browser agrees is checked by hand and recorded in the
 * task report.
 */
function fakeView(size: { articleHeight: number; viewportHeight: number; empty?: boolean }): {
  doc: Document;
  win: Window;
  bar: { dataset: Record<string, string | undefined> };
  listeners: { type: string; handler: () => void }[];
  fire: (type: string) => void;
  resize: (height: number) => void;
} {
  const article = { offsetHeight: size.articleHeight };
  const bar = { dataset: {} as Record<string, string | undefined> };
  const listeners: { type: string; handler: () => void }[] = [];
  const doc = {
    querySelector: (selector: string) =>
      size.empty === true ? null : selector.includes('progress') ? bar : article,
  };
  const win = {
    innerHeight: size.viewportHeight,
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    addEventListener: (type: string, handler: () => void) => {
      listeners.push({ type, handler });
    },
    removeEventListener: (type: string, handler: () => void) => {
      const at = listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  return {
    doc: doc as unknown as Document,
    win: win as unknown as Window,
    bar,
    listeners,
    fire: (type: string) => {
      for (const l of [...listeners]) if (l.type === type) l.handler();
    },
    resize: (height: number) => {
      win.innerHeight = height;
    },
  };
}
