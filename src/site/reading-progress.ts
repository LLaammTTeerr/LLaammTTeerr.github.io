/**
 * §6.1 — the reading-progress indicator's one decision, and the only
 * JavaScript on a post page that is not the verifier.
 *
 * **The bar itself is not driven from here.** It is a CSS scroll-driven
 * animation (`view-timeline-name` on the article, `animation-timeline` on the
 * fill — see `src/styles/post.css`), which the compositor runs off the main
 * thread. A scroll listener would be a handler on every post page, on a site
 * that ships almost no JavaScript by design, and it would run inside the
 * browser's scrolling rather than beside it.
 *
 * What CSS cannot answer is whether the bar should exist at all. §6.1 requires
 * the indicator not to appear when the article is shorter than the viewport —
 * "a progress bar for something with no progress is noise" — and that is a
 * comparison between an element's rendered height and the viewport's, which no
 * selector, media query or container query can make. (`container-type: size`
 * can query a height, but applying size containment to the article would
 * collapse it: its height *is* its contents.) So one measurement is taken, on
 * load and whenever the viewport changes, and written to a data attribute the
 * stylesheet keys the animation off.
 *
 * Reads no clock (§14): nothing here can make two builds disagree, and nothing
 * here runs at build time at all.
 */

/** An article's rendered height against the viewport it is being read in. */
export interface ProgressView {
  /** The article card's rendered height, in CSS pixels. */
  articleHeight: number;
  /** The viewport's height, in CSS pixels. */
  viewportHeight: number;
}

/**
 * The value `data-on` should carry — the attribute the stylesheet's
 * `.post-progress[data-on='true'] i` rule keys the animation off.
 *
 * A string rather than a boolean because that is what a `dataset` write
 * actually stores, and because the two spellings are what the cascade sees.
 *
 * The comparison is strict. An article exactly one viewport tall has nothing
 * below the fold, so it has no progress to report; and a viewport of zero
 * height is a measurement taken before layout, not an article of infinite
 * length, which is why it answers `'false'` rather than `'true'`.
 */
export function readingProgressState(view: ProgressView): 'true' | 'false' {
  if (view.viewportHeight <= 0) return 'false';
  return view.articleHeight > view.viewportHeight ? 'true' : 'false';
}

/**
 * Measure once, then again whenever the viewport changes, and return the
 * function that unbinds.
 *
 * `resize` and not `scroll`: the decision depends on two heights, neither of
 * which a scroll changes. The measurement is deferred to an animation frame so
 * a drag that fires a hundred `resize` events reads layout once per frame
 * rather than a hundred times.
 *
 * `doc` and `win` are parameters rather than globals so the wiring — not only
 * the arithmetic — can be driven in a test.
 */
export function watchReadingProgress(doc: Document, win: Window): () => void {
  const article = doc.querySelector<HTMLElement>('article.post');
  const bar = doc.querySelector<HTMLElement>('.post-progress');
  // A page without both is not a post page, and binding a listener to it would
  // be a listener that can never do anything.
  if (article === null || bar === null) return () => undefined;

  let queued = 0;
  const measure = (): void => {
    queued = 0;
    bar.dataset.on = readingProgressState({
      articleHeight: article.offsetHeight,
      viewportHeight: win.innerHeight,
    });
  };
  const onResize = (): void => {
    if (queued !== 0) return;
    queued = win.requestAnimationFrame(measure);
  };

  measure();
  win.addEventListener('resize', onResize, { passive: true });
  return () => {
    win.removeEventListener('resize', onResize);
  };
}
