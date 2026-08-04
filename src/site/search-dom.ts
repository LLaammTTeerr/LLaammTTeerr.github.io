import { createSearchBox, type SearchController, type SearchState } from './search-box';
import type { SearchIndex } from './search-index';
import type { SearchHit } from './search-query';

/**
 * §9 — the search box's adapter: DOM events in, DOM attributes out.
 *
 * `search-query.ts` decides what a query answers and `search-box.ts` decides
 * when things happen. This is the third and thinnest part, and it is a module
 * rather than a `<script>` body in `Search.astro` **because of a measured hole
 * in the tests**: a reviewer deleted every `setAttribute` in this code —
 * `role="option"`, `aria-selected`, `aria-expanded`, `aria-controls`,
 * `aria-autocomplete`, `aria-activedescendant` — plus the `mousedown` guard
 * that makes a result clickable at all, and the suite stayed green at 1024/3
 * while the browser showed a stateless combobox nobody could use. Behaviour
 * that only a hand-driven browser pass has ever checked is behaviour with no
 * net under it, and the next change to this file would have shipped whatever it
 * broke.
 *
 * So the whole adapter is one exported function over a `Document`, and
 * `tests/site/search.test.ts` drives it against a small hand-written DOM,
 * asserting the attributes and the click. What the real browser confirms —
 * repeatedly, and recorded in the task report — is that the shim models the
 * browser faithfully; what the suite now guarantees is that this file cannot
 * quietly stop setting them.
 *
 * `load` and `go` are injected rather than reached for here. `Search.astro`
 * passes `fetch('/search-index.json')` and `window.location.assign`, which
 * keeps the one network call in the component where the §9 bundle guard reads
 * it, and keeps this module free of anything a test would have to stub
 * globally.
 *
 * Deliberately no `instanceof HTMLInputElement` and friends: the elements are
 * looked up by ids this project's own markup declares, a null check is the
 * honest test for "the markup changed", and an `instanceof` against a global
 * would be a check on which realm the code is running in rather than on the
 * document. No clock (§14).
 */

export interface SearchDomDeps {
  /** Fetch and parse the index. Called at most once per successful load. */
  load(): Promise<SearchIndex>;
  /** Send the reader to a site-internal path. */
  go(href: string): void;
}

/** Ids this component's markup declares. One place, so a rename is one edit. */
export const SEARCH_IDS = {
  field: 'search-q',
  panel: 'search-panel',
  list: 'search-list',
  note: 'search-note',
  live: 'search-live',
  hint: 'search-hint',
  /** The `<noscript>` explanation, which exists only when nothing runs. */
  nojs: 'search-nojs',
} as const;

/** `search-opt-3` — an option's id, which `aria-activedescendant` points at. */
export const optionId = (at: number): string => `search-opt-${String(at)}`;

/**
 * Wire the box up in `document`. Returns the controller, or `null` when the
 * markup this expects is not on the page — which is not an error worth throwing
 * over in a nav row that renders on all 43 pages, but is worth being explicit
 * about rather than silently half-attaching.
 */
export function attachSearch(document: Document, deps: SearchDomDeps): SearchController | null {
  const field = document.getElementById(SEARCH_IDS.field) as HTMLInputElement | null;
  const panel = document.getElementById(SEARCH_IDS.panel);
  const list = document.getElementById(SEARCH_IDS.list);
  const noteLine = document.getElementById(SEARCH_IDS.note);
  const live = document.getElementById(SEARCH_IDS.live);
  if (field === null || panel === null || list === null || noteLine === null || live === null) {
    return null;
  }

  /**
   * One result row. Built with `textContent` throughout — every string in it
   * came out of a document fetched over a network.
   *
   * No `<a>` inside: an option in a listbox owns its own accessible name, and a
   * link nested in one is announced as a second, competing control. The row is
   * the option, and Enter or a click navigates. What that costs is real —
   * middle-clicking a result into a new tab does not work — and it is the side
   * of the trade the brief asked for.
   */
  function option(hit: SearchHit, at: number, isActive: boolean): HTMLElement {
    const row = document.createElement('li');
    row.id = optionId(at);
    row.className = 'search-opt';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(isActive));
    row.dataset['at'] = String(at);
    row.dataset['kind'] = hit.kind;

    const label = document.createElement('span');
    label.className = 'search-label';
    label.textContent = hit.label;

    const detail = document.createElement('span');
    detail.className = 'search-detail';
    detail.textContent = hit.detail;

    row.append(label, detail);
    return row;
  }

  function render(state: SearchState): void {
    // Only when it differs, so Escape can empty the box without the caret
    // jumping on every keystroke a reader makes.
    if (field!.value !== state.query) field!.value = state.query;

    field!.setAttribute('aria-expanded', String(state.open));
    panel!.hidden = !state.open;

    list!.replaceChildren(...state.hits.map((hit, at) => option(hit, at, at === state.active)));

    if (state.active >= 0 && state.open) {
      field!.setAttribute('aria-activedescendant', optionId(state.active));
      // `block: 'nearest'`, and no `behavior` — the default is instant, which
      // is what a reader arrowing quickly through a list wants, and what
      // `prefers-reduced-motion` asks for without having to be consulted.
      (list!.children[state.active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
    } else {
      field!.removeAttribute('aria-activedescendant');
    }

    noteLine!.textContent = state.note ?? '';
    noteLine!.hidden = state.note === null;
    if (live!.textContent !== state.status) live!.textContent = state.status;
  }

  const box = createSearchBox({ load: deps.load, view: { render, go: deps.go } });

  // The combobox is made here, with the behaviour, and never in the markup: a
  // `role="combobox"` on a disabled input that can never expand is a promise to
  // a screen reader that nothing on the page can keep.
  field.setAttribute('role', 'combobox');
  field.setAttribute('aria-expanded', 'false');
  field.setAttribute('aria-controls', SEARCH_IDS.list);
  field.setAttribute('aria-autocomplete', 'list');
  // Narrowed from the markup's `"<nojs> <hint>"`: the `<noscript>` paragraph is
  // not in this document, and pointing at an id that is not there would leave a
  // dangling reference for a screen reader to resolve to nothing.
  field.setAttribute('aria-describedby', SEARCH_IDS.hint);
  field.disabled = false;

  field.addEventListener('focus', () => box.focus());
  field.addEventListener('input', () => box.input(field.value));
  field.addEventListener('blur', () => box.dismiss());
  field.addEventListener('keydown', (event) => {
    if (box.key(event.key)) event.preventDefault();
  });
  // A click on an input the reader is already focused in fires no `focus`, so
  // this is the only way the retry that `INDEX_UNREACHABLE` instructs can
  // happen. A no-op unless the last load failed.
  field.addEventListener('click', () => box.retry());

  // `mousedown` rather than `click`: the default action of pressing inside the
  // panel moves focus out of the input, which fires `blur` and closes the panel
  // before the click can land on anything. Without this, results are visible
  // and unclickable.
  panel.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const row = (event.target as Element | null)?.closest('.search-opt') as HTMLElement | null;
    const at = row?.dataset['at'];
    if (at !== undefined) box.choose(Number(at));
  });

  return box;
}
