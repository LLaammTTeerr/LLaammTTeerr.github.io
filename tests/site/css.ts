/**
 * A very small CSS reader for tests that need to reason about rules rather
 * than about the text of a stylesheet.
 *
 * Substring assertions over raw CSS are satisfiable by prose: `tokens.css`'s
 * header comment names `[data-palette="github-dark"]`, so a `toContain` for
 * that selector can pass with no such rule in the file. Everything here
 * works on parsed rules with comments stripped, so a comment can never
 * satisfy an assertion about a selector.
 */

export interface CssRule {
  /** The selector list, whitespace collapsed: `[data-meter="m1"] .meter-m2, .x`. */
  selector: string;
  /** The declaration block's text, between the braces. */
  body: string;
  /** The enclosing at-rule prelude (`@media (max-width:44rem)`), or null. */
  atRule: string | null;
  /** Position in the stylesheet — later rules win ties in the cascade. */
  order: number;
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every declaration-block rule in source order, including rules nested in
 * at-rules (tagged with `atRule` so a caller can reject what it cannot
 * model). At-rules with no selector of their own — `@font-face`, `@import` —
 * are not returned as rules.
 */
export function parseRules(css: string): CssRule[] {
  const text = stripComments(css);
  const rules: CssRule[] = [];
  const openAtRules: string[] = [];
  let prelude = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{') {
      const selector = prelude.trim().replace(/\s+/g, ' ');
      prelude = '';
      if (selector.startsWith('@')) {
        openAtRules.push(selector);
        continue;
      }
      let depth = 1;
      let body = '';
      let j = i + 1;
      for (; j < text.length; j++) {
        const c = text[j]!;
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
        body += c;
      }
      rules.push({
        selector,
        body,
        atRule: openAtRules[openAtRules.length - 1] ?? null,
        order: rules.length,
      });
      i = j;
      continue;
    }
    if (ch === '}') {
      openAtRules.pop();
      prelude = '';
      continue;
    }
    prelude += ch;
  }
  return rules;
}

/** The individual selectors of a rule's comma-separated selector list. */
export function selectorParts(rule: CssRule): string[] {
  return rule.selector.split(',').map((s) => s.trim()).filter(Boolean);
}

/** True when some rule's selector contains `needle` in selector position. */
export function hasSelectorContaining(css: string, needle: string): boolean {
  return parseRules(css).some((rule) => selectorParts(rule).some((part) => part.includes(needle)));
}

/** Custom property names declared by rules whose selector is exactly `selector`. */
export function propsDeclaredBy(css: string, selector: string): Set<string> {
  const props = new Set<string>();
  for (const rule of parseRules(css)) {
    if (!selectorParts(rule).includes(selector)) continue;
    for (const decl of rule.body.matchAll(/(--[\w-]+)\s*:/g)) props.add(decl[1]!);
  }
  return props;
}

/** The last value declared for `property` in a declaration block. */
export function declaredValue(body: string, property: string): string | null {
  const matches = [...body.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))];
  const last = matches[matches.length - 1];
  return last ? last[1]!.trim() : null;
}

/* ------------------------------------------------------------------ *
 * Resolving one property through the whole cascade
 * ------------------------------------------------------------------ */

/**
 * An element, as a cascade evaluation needs it: what it is, and what it wears.
 *
 * A chain of these, outermost first, stands in for one element's position in
 * the document.
 */
export interface StyledElement {
  tag: string;
  id?: string;
  classes?: string[];
  /** Present attributes, so `[hidden]` and `[data-kind='x']` can be modelled. */
  attrs?: Record<string, string>;
}

/** `[a, b, c]` — ids, then classes/attributes, then element names. */
type Specificity = [number, number, number];

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

interface Step {
  compound: Compound;
  /** How this step relates to the one before it. `null` on the first. */
  combinator: ' ' | '>' | null;
}

/** Thrown by `resolveProperty` for a selector this evaluator cannot model. */
export class UnmodelledSelector extends Error {}

/**
 * One compound selector — `ul`, `.nav`, `#search-list`, `.a.b[hidden]` — or
 * `null` when it uses something this evaluator does not model.
 */
function parseCompound(text: string): Compound | null {
  const compound: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = text;
  let first = true;
  while (rest !== '') {
    const tag = first ? /^([a-zA-Z][\w-]*)/.exec(rest) : null;
    if (tag !== null) {
      compound.tag = tag[1]!.toLowerCase();
      rest = rest.slice(tag[0].length);
      first = false;
      continue;
    }
    first = false;
    const id = /^#([\w-]+)/.exec(rest);
    if (id !== null) {
      compound.id = id[1]!;
      rest = rest.slice(id[0].length);
      continue;
    }
    const cls = /^\.([\w-]+)/.exec(rest);
    if (cls !== null) {
      compound.classes.push(cls[1]!);
      rest = rest.slice(cls[0].length);
      continue;
    }
    const attr = /^\[([\w-]+)(?:=(["']?)([^\]"']*)\2)?\]/.exec(rest);
    if (attr !== null) {
      compound.attrs.push({ name: attr[1]!, value: attr[3] ?? null });
      rest = rest.slice(attr[0].length);
      continue;
    }
    // A pseudo-class, a pseudo-element, `*`, a namespace — not modelled.
    return null;
  }
  return compound;
}

/** A whole selector as a list of steps, or `null` if any part is not modelled. */
function parseSelector(selector: string): Step[] | null {
  // `+` and `~` are siblings, which a single ancestor chain cannot answer.
  if (/[+~]/.test(selector)) return null;
  const parts = selector.split(/\s*(>)\s*|\s+/).filter((p) => p !== undefined && p !== '');
  const steps: Step[] = [];
  let combinator: ' ' | '>' | null = null;
  for (const part of parts) {
    if (part === '>') {
      combinator = '>';
      continue;
    }
    const compound = parseCompound(part);
    if (compound === null) return null;
    steps.push({ compound, combinator: steps.length === 0 ? null : (combinator ?? ' ') });
    combinator = null;
  }
  return steps.length === 0 ? null : steps;
}

function matchesCompound(element: StyledElement, compound: Compound): boolean {
  if (compound.tag !== null && compound.tag !== element.tag.toLowerCase()) return false;
  if (compound.id !== null && compound.id !== element.id) return false;
  const classes = element.classes ?? [];
  if (!compound.classes.every((c) => classes.includes(c))) return false;
  const attrs = element.attrs ?? {};
  return compound.attrs.every(({ name, value }) => {
    if (!(name in attrs)) return false;
    return value === null || attrs[name] === value;
  });
}

/**
 * Whether `steps` matches the last element of `chain`, matched right to left
 * with backtracking over descendant combinators.
 */
function matchesChain(chain: StyledElement[], steps: Step[]): boolean {
  const walk = (stepAt: number, elementAt: number): boolean => {
    const step = steps[stepAt]!;
    if (elementAt < 0) return false;
    if (!matchesCompound(chain[elementAt]!, step.compound)) return false;
    if (stepAt === 0) return true;
    const next = steps[stepAt]!.combinator;
    if (next === '>') return walk(stepAt - 1, elementAt - 1);
    for (let at = elementAt - 1; at >= 0; at--) {
      if (walk(stepAt - 1, at)) return true;
    }
    return false;
  };
  return walk(steps.length - 1, chain.length - 1);
}

function specificityOf(steps: Step[]): Specificity {
  const out: Specificity = [0, 0, 0];
  for (const { compound } of steps) {
    if (compound.id !== null) out[0] += 1;
    out[1] += compound.classes.length + compound.attrs.length;
    if (compound.tag !== null) out[2] += 1;
  }
  return out;
}

const beats = (a: Specificity, b: Specificity): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/**
 * The value `property` actually resolves to for the last element of `chain`,
 * under the whole of `css`, or `null` when no rule matches it.
 *
 * **Why this exists rather than a `toContain` over the stylesheet.** The search
 * results shipped as a wrapped horizontal row of chips because
 * `base.css`'s `.nav ul` — (0,1,1) — reached `#search-list` and beat the
 * component's own `.search-list` — (0,1,0) — however late `search.css` loaded.
 * Every declaration involved was present and correct in its own file; the
 * defect was in the cascade *between* them, and no assertion about a rule
 * existing can see it. This resolves the property the way a browser does:
 * every matching rule, ordered by specificity then source order.
 *
 * It follows `dist-output.test.ts`'s meter evaluator in **refusing rather than
 * silently skipping** what it cannot model. A selector using a pseudo-class, a
 * pseudo-element, `*`, or a sibling combinator is skipped when it plainly
 * cannot concern this chain, and throws `UnmodelledSelector` when it mentions
 * any class or id the chain carries — so a rule that might really decide the
 * answer can never be quietly ignored. At-rules are treated the same way:
 * this evaluator does not model media queries, and one that declares
 * `property` on this chain is a refusal, not a shrug.
 *
 * What it models: type, id, class and attribute selectors, descendant and child
 * combinators, specificity, source order. What it does not: `!important`,
 * inline styles, inheritance, shorthand expansion, and every selector shape
 * listed above.
 */
export function resolveProperty(
  css: string,
  chain: StyledElement[],
  property: string,
): string | null {
  const subject = chain[chain.length - 1];
  if (subject === undefined) throw new Error('resolveProperty was given an empty chain');
  // Only classes and ids: a bare tag name like `div` appears inside far too
  // many unrelated selectors (KaTeX alone ships hundreds) for its presence to
  // be evidence that a rule concerns this element.
  const marks = new Set(chain.flatMap((e) => [...(e.classes ?? []), ...(e.id === undefined ? [] : [e.id])]));
  const concerns = (part: string): boolean => [...marks].some((mark) => part.includes(mark));

  let winner: { value: string; specificity: Specificity } | null = null;
  for (const rule of parseRules(css)) {
    const value = declaredValue(rule.body, property);
    if (value === null) continue;
    for (const part of selectorParts(rule)) {
      const steps = parseSelector(part);
      if (steps === null) {
        if (concerns(part)) {
          throw new UnmodelledSelector(`"${part}" declares ${property} and is not modelled`);
        }
        continue;
      }
      if (!matchesChain(chain, steps)) continue;
      if (rule.atRule !== null) {
        throw new UnmodelledSelector(
          `"${part}" declares ${property} inside ${rule.atRule}; at-rules are not modelled`,
        );
      }
      const specificity = specificityOf(steps);
      // Later source order wins a tie, which is why this is `!beats(winner, …)`
      // rather than a strict comparison.
      if (winner === null || !beats(winner.specificity, specificity)) {
        winner = { value, specificity };
      }
    }
  }
  return winner?.value ?? null;
}
