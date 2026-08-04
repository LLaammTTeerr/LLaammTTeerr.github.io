/**
 * A very small DOM, for testing a module whose whole job is to touch one.
 *
 * `src/site/search-dom.ts` sets `role="option"`, `aria-selected`,
 * `aria-expanded`, `aria-controls`, `aria-autocomplete` and
 * `aria-activedescendant`, and guards the panel's `mousedown` so a result can
 * be clicked at all. A reviewer deleted every one of those and the suite stayed
 * green at 1024 passing — the browser then showed a stateless combobox nobody
 * could use, and nothing said so. Static scans of the built bundle would have
 * caught that particular deletion and would not catch `aria-selected` being set
 * to a constant, so what is needed is the adapter actually running.
 *
 * The alternative was a headless browser in the suite, which means a
 * devDependency and a CI runner that has one. This is the cheaper half of that
 * trade and it is honest about its limits: **it models the DOM API the adapter
 * uses and nothing else**. It does not lay anything out, it does not compute a
 * style, and it does not implement focus. Layout is the business of the
 * cascade evaluator in `css.ts`, and that the real browser agrees with this
 * shim is checked by hand and recorded in the task report.
 *
 * Every method here exists because `search-dom.ts` calls it. Anything it does
 * not call is deliberately absent, so this file cannot quietly become a second
 * browser to maintain.
 */

/** An event, with only the parts the adapter reads. */
export interface FakeEvent {
  type: string;
  target: FakeElement | null;
  key: string;
  /** How many times the handler asked the browser not to do the default. */
  prevented: number;
  preventDefault(): void;
}

type Handler = (event: FakeEvent) => void;

export class FakeElement {
  readonly tag: string;
  id = '';
  className = '';
  textContent = '';
  hidden = false;
  /** Only an input has these two; kept here so the adapter's casts work. */
  value = '';
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  /** How many times `scrollIntoView` was asked to reveal this element. */
  scrolled = 0;

  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  scrollIntoView(): void {
    this.scrolled += 1;
  }

  /** `.class` only — the one form the adapter uses. */
  closest(selector: string): FakeElement | null {
    const wanted = selector.replace(/^\./, '');
    for (let node: FakeElement | null = this; node !== null; node = node.parent) {
      if (node.className.split(/\s+/).includes(wanted)) return node;
    }
    return null;
  }

  /** The first descendant carrying `className`, depth first. For assertions. */
  find(className: string): FakeElement | null {
    for (const child of this.children) {
      if (child.className.split(/\s+/).includes(className)) return child;
      const deeper = child.find(className);
      if (deeper !== null) return deeper;
    }
    return null;
  }

  /**
   * Dispatch an event at this element and let it bubble, exactly as a real one
   * does — which is load-bearing, not decoration: the adapter listens for
   * `click` on the **list** while the thing a reader actually clicks is a
   * `<span>` two levels inside a row. A shim that only ran handlers on the
   * target would report the row as unclickable, and one that ignored `target`
   * would report every click as landing on the first row.
   */
  fire(type: string, init: { key?: string } = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      target: this,
      key: init.key ?? '',
      prevented: 0,
      preventDefault(): void {
        this.prevented += 1;
      },
    };
    for (let node: FakeElement | null = this; node !== null; node = node.parent) {
      for (const handler of node.handlersFor(type)) handler(event);
    }
    return event;
  }

  private handlersFor(type: string): Handler[] {
    return [...(this.handlers.get(type) ?? [])];
  }
}

export class FakeDocument {
  private readonly byId = new Map<string, FakeElement>();

  /** Registers an element under `id`, wiring `parent` for bubbling. */
  add(id: string, tag: string, parent: FakeElement | null = null): FakeElement {
    const element = new FakeElement(tag);
    element.id = id;
    element.parent = parent;
    if (parent !== null) parent.children.push(element);
    this.byId.set(id, element);
    return element;
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
}

/** The five elements `attachSearch` looks up, in the nesting the markup has. */
export interface SearchDom {
  document: FakeDocument;
  field: FakeElement;
  panel: FakeElement;
  list: FakeElement;
  note: FakeElement;
  live: FakeElement;
}

/**
 * The component's markup, as much of it as the adapter reaches for.
 *
 * Built here rather than parsed out of `dist/`: what this fixture must match is
 * the *ids*, and those are asserted against the built page by the group in
 * `search.test.ts` that reads `dist/index.html`. Parsing real HTML here would
 * add an HTML parser to a file whose whole point is that it is small.
 */
export function searchDom(): SearchDom {
  const document = new FakeDocument();
  const root = new FakeElement('div');
  root.className = 'search';
  const field = document.add('search-q', 'input', root);
  field.disabled = true;
  const panel = document.add('search-panel', 'div', root);
  panel.hidden = true;
  const list = document.add('search-list', 'ul', panel);
  const note = document.add('search-note', 'p', panel);
  note.hidden = true;
  const live = document.add('search-live', 'span', root);
  return { document, field, panel, list, note, live };
}
