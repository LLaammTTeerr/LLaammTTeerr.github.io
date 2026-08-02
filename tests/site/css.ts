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
