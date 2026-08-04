import type { SearchIndex } from './search-index';
import { INDEX_UNREACHABLE, LOADING, searchFor, type SearchHit } from './search-query';

/**
 * §8/§9 — the search box's behaviour, with no DOM in it.
 *
 * `search-query.ts` decides *what* a query answers. This decides **when**: when
 * the index is fetched, what is open, what is active, what Enter does. Both
 * halves are separated from `Search.astro` for the same reason the verifier's
 * arithmetic is separated from its markup — a control that renders and does
 * nothing passes a great many tests, and the only way to assert "fetched on
 * first focus and not before" without a browser is for the fetch to be an
 * injected function whose calls can be counted.
 *
 * What that leaves in `Search.astro` is an adapter: read events off an input,
 * paint a state onto a list. It is thin on purpose, and it was driven by hand
 * in a real browser, because nothing here can prove that the adapter binds
 * `focus` to `focus()`.
 *
 * No clock (§14), no filesystem, no module-level state — one controller per
 * call, so two boxes on one page could not share a fetch by accident.
 */

/** Where a controller sends what it has decided. */
export interface SearchView {
  /**
   * Paint this state. Called after **every** event, with a fresh object each
   * time: a caller that kept the previous state to diff against must be able to
   * trust that it has not been mutated underneath.
   */
  render(state: SearchState): void;
  /** Go to a site-internal path. */
  go(href: string): void;
}

export interface SearchDeps {
  /**
   * Fetch and parse the index. Called **at most once per successful load** —
   * the controller memoizes it, so this is the raw fetch and not a cached one.
   */
  load(): Promise<SearchIndex>;
  view: SearchView;
}

export interface SearchState {
  /** Exactly what the reader has typed, untrimmed. */
  query: string;
  hits: readonly SearchHit[];
  /** Index into `hits`, or `-1` when nothing is active. */
  active: number;
  /** Whether the popup should be showing. */
  open: boolean;
  /** True while the index is in flight. */
  loading: boolean;
  /** Vietnamese prose the panel shows, or `null`. */
  note: string | null;
  /**
   * One line for the live region — what a reader who cannot see the panel is
   * told. Empty when there is nothing to announce.
   */
  status: string;
}

export interface SearchController {
  /**
   * The reader has put the caret in the box. **This is the only thing that
   * starts a fetch** other than `retry()`, and it starts at most one: §8 asks
   * for the index "lazy-loaded on first focus", which means a reader who never
   * uses the box downloads nothing for it, on every page of the site.
   */
  focus(): void;
  /**
   * The reader pressed on the box again. Starts a load only if the last one
   * failed and none is under way; after a success it is a no-op.
   *
   * This exists because `INDEX_UNREACHABLE` tells the reader to click the box
   * again, and a reader who has just watched a fetch fail is **still focused in
   * it** — clicking an already-focused input fires `mousedown` and `click` and
   * no `focus` at all, so the one gesture the note named was the one gesture
   * that could not work. Measured: the fetch count stayed at 1 through the
   * click and only reached 2 after a blur and a refocus. The wording could have
   * been changed instead; making the stated gesture work is the better half of
   * that choice, since it is also what a reader does without being told.
   *
   * It does not touch the panel: a click that reopens a popup the reader has
   * just dismissed with Escape would be a second, unasked-for behaviour riding
   * along on a bug fix.
   */
  retry(): void;
  /** The reader has typed or pasted. */
  input(value: string): void;
  /** A key went down. Returns true when the box consumed it. */
  key(key: string): boolean;
  /** A result was clicked. */
  choose(index: number): void;
  /** Focus left the box, or something outside it was clicked. */
  dismiss(): void;
  /**
   * Resolves once any in-flight load has settled and its result painted.
   * For tests; a browser has no use for it.
   */
  ready(): Promise<void>;
  readonly state: SearchState;
}

export function createSearchBox(deps: SearchDeps): SearchController {
  let index: SearchIndex | null = null;
  let query = '';
  let hits: SearchHit[] = [];
  let active = -1;
  let opened = false;
  let loading = false;
  let failed = false;
  /** Whether a load has been started and not yet failed. */
  let started = false;
  let pending: Promise<void> | null = null;
  let queryNote: string | null = null;

  const trimmed = (): string => query.trim();
  const isOpen = (): boolean => opened && trimmed() !== '';

  /**
   * The visible line in the panel.
   *
   * The loading sentence is here and not only in the live region, which is
   * where it used to be: a reader who typed while the document was still in
   * flight got an open panel, no rows, and an explanation only a screen reader
   * was told. A panel that shows nothing and says nothing is the empty void
   * this box is not allowed to render, whatever the reason for it.
   */
  function note(): string | null {
    if (failed) return INDEX_UNREACHABLE;
    if (loading) return trimmed() === '' ? null : LOADING;
    if (index === null) return null;
    return queryNote;
  }

  function status(): string {
    if (trimmed() === '') return '';
    const said = note();
    if (said !== null) return said;
    // Announced in the reader's own language, like every other sentence the
    // site addresses them in; the chrome around it is what stays English.
    return hits.length === 0 ? '' : `${String(hits.length)} kết quả`;
  }

  function snapshot(): SearchState {
    return {
      query,
      hits: [...hits],
      active,
      open: isOpen(),
      loading,
      note: note(),
      status: status(),
    };
  }

  function render(): void {
    deps.view.render(snapshot());
  }

  /**
   * Re-answer the current query. The first result is made active so that Enter
   * straight after typing goes somewhere: this box's job is to get a reader to
   * a page in as few keystrokes as it can, and a popup whose first row must be
   * arrowed onto before it can be opened costs one keystroke on every use.
   */
  function recompute(): void {
    if (index === null) {
      hits = [];
      queryNote = null;
    } else {
      const outcome = searchFor(index, query);
      hits = outcome.hits;
      queryNote = outcome.note;
    }
    active = hits.length === 0 ? -1 : 0;
  }

  /**
   * Start the one fetch, if it has not been started.
   *
   * A failure clears `started`, so a reader whose network dropped can focus the
   * box again and try; a success never re-fetches, however many times the box
   * is focused. The returned promise never rejects — an unhandled rejection in
   * the nav row of every page on the site would be a console error on every
   * flaky connection.
   */
  function ensure(): void {
    if (started) return;
    started = true;
    failed = false;
    loading = true;
    pending = deps.load().then(
      (loaded) => {
        index = loaded;
        loading = false;
        recompute();
        render();
      },
      () => {
        started = false;
        loading = false;
        failed = true;
        render();
      },
    );
  }

  function move(delta: number): void {
    if (hits.length === 0) {
      active = -1;
      return;
    }
    const from = active < 0 ? (delta > 0 ? -1 : 0) : active;
    active = (from + delta + hits.length) % hits.length;
  }

  function go(at: number): void {
    const hit = hits[at];
    if (hit === undefined) return;
    deps.view.go(hit.href);
    opened = false;
    render();
  }

  return {
    focus(): void {
      ensure();
      opened = true;
      render();
    },

    retry(): void {
      const before = started;
      ensure();
      // Nothing was armed, so nothing changed on screen either.
      if (started !== before) render();
    },

    input(value: string): void {
      // No `ensure()` here, deliberately: a reader cannot type into a box they
      // have not focused, so the load is already under way or already done —
      // and after a failed load, typing must show the reader why the box is
      // silent rather than quietly starting a second fetch they never asked
      // for and cannot see the outcome of.
      query = value;
      recompute();
      opened = true;
      render();
    },

    key(key: string): boolean {
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        if (trimmed() === '') return false;
        if (!opened) {
          // A closed panel reopens rather than moving a selection nobody can
          // see — otherwise the second ArrowDown lands on the second result.
          opened = true;
          active = hits.length === 0 ? -1 : 0;
        } else {
          move(key === 'ArrowDown' ? 1 : -1);
        }
        render();
        return true;
      }

      if (key === 'Enter') {
        if (!isOpen() || active < 0) return false;
        go(active);
        return true;
      }

      if (key === 'Escape') {
        // Twice over, in the order a reader expects: the first press takes the
        // panel away and leaves the query to be edited, the second empties the
        // box. Consumed both times, so a browser that clears a `type="search"`
        // input on Escape cannot do both at once.
        if (isOpen()) {
          opened = false;
        } else {
          query = '';
          recompute();
        }
        render();
        return true;
      }

      return false;
    },

    choose(at: number): void {
      go(at);
    },

    dismiss(): void {
      opened = false;
      active = -1;
      render();
    },

    ready(): Promise<void> {
      return pending ?? Promise.resolve();
    },

    get state(): SearchState {
      return snapshot();
    },
  };
}
