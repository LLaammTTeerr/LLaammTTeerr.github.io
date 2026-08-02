import rehypeShiki from '@shikijs/rehype';
import type { Element, Parents, Root } from 'hast';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { createCssVariablesTheme } from 'shiki';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * Shiki's `css-variables` theme is generated on demand, not one of the
 * bundled TextMate themes — passing the *name* `'css-variables'` to
 * `@shikijs/rehype` throws (`Theme \`css-variables\` is not included in this
 * bundle`), confirmed against the installed shiki@4.4.1. The theme *object*
 * from `createCssVariablesTheme` is the documented way to get it
 * (https://shiki.style/guide/theme-colors#css-variables-theme) and produces
 * the identical `var(--shiki-*)` output the string form would have, so this
 * is the same design decision, just invoked through the API that actually
 * works — not a fallback to a fixed theme.
 */
const cssVariablesTheme = createCssVariablesTheme({ name: 'css-variables', variablePrefix: '--shiki-' });

/** URL-bearing attributes we police, keyed by the element that carries them. */
const URL_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  img: ['src'],
};

/** Schemes a post body may link or embed through. Anything else is dropped. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

/**
 * Whether `raw` is safe to leave as a `href`/`src`.
 *
 * Site-relative (`/…`), protocol-relative (`//…`), fragment (`#…`), and
 * scheme-less URLs are all safe: a browser resolves them against the current
 * page and none of them execute code. Anything with an explicit scheme must
 * be on the allowlist.
 *
 * Browsers strip ASCII tab/newline/carriage-return from anywhere in a URL
 * before parsing its scheme (not just the edges), so `java\tscript:alert(1)`
 * resolves to the `javascript:` scheme even though naive trimming would miss
 * it. We strip the same characters before testing. By the time a plugin sees
 * this value, remark has already resolved any HTML entities in the original
 * markdown into literal characters, so no separate entity-decoding step is
 * needed here.
 */
function isSafeUrl(raw: string): boolean {
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (stripped === '') return true;
  if (stripped.startsWith('//')) return true; // protocol-relative
  if (/^[/#?.]/.test(stripped)) return true; // site-relative or fragment
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (!match) return true; // no scheme at all: a relative reference
  const scheme = match[1]!.toLowerCase(); // capture group 1 always matches when `match` is non-null
  return SAFE_SCHEMES.has(scheme);
}

/**
 * Neutralises unsafe URL protocols (`javascript:`, `data:`, `vbscript:`, …)
 * on `href`/`src`. The reason raw author HTML is dropped elsewhere in this
 * pipeline — a body hashed into the chain is tamper-evident, not safe, since
 * the author is still typing it and the page carries reader preferences and
 * a verify control — applies identically to a link that would run script on
 * click. Deliberately narrow (URL attributes only) rather than a general
 * sanitize schema: later tasks add KaTeX and Shiki output that a default
 * sanitizer would strip.
 *
 * An unsafe element is unwrapped rather than left in place with the
 * attribute merely removed. A hrefless `<a>` is not focusable, but it isn't
 * reliably announced as inert either — some assistive tech still exposes it
 * with the "link" role, which would read the author's link text aloud as if
 * it were interactive and then do nothing on activation. Unwrapping to the
 * element's own children (plain text for an anchor, nothing for a
 * childless `<img>`) removes that ambiguity instead of trading one hazard
 * for a smaller one.
 *
 * Two passes on purpose: the first walks the tree read-only and records
 * which nodes to unwrap; the second performs the splices in reverse index
 * order per parent. Splicing during `visit` itself would shift sibling
 * indices out from under the traversal.
 */
function rehypeSafeUrls() {
  return (tree: Root) => {
    const unsafe: Array<{ parent: Parents; index: number }> = [];
    visit(tree, 'element', (node: Element, index, parent) => {
      const attrs = URL_ATTRS[node.tagName];
      if (!attrs || !parent || typeof index !== 'number') return;
      const isUnsafe = attrs.some((attr) => {
        const value = node.properties[attr];
        return typeof value === 'string' && !isSafeUrl(value);
      });
      if (isUnsafe) unsafe.push({ parent, index });
    });
    // Reverse so a splice at a later index never invalidates an
    // earlier-recorded index within the same parent.
    for (const { parent, index } of unsafe.reverse()) {
      const node = parent.children[index] as Element;
      parent.children.splice(index, 1, ...node.children);
    }
  };
}

/**
 * §6.1 — renders the verified body from `getPostContent`.
 *
 * `allowDangerousHtml` is deliberately off. A body is hashed into the chain,
 * which makes it tamper-evident, not safe: the author is still typing it, and
 * the page around it carries reader preferences and a verify control. Raw HTML
 * in a post is dropped rather than passed through — `remarkRehype` folds
 * HTML-block constructs into opaque nodes and, without `allowDangerousHtml`,
 * discards them wholesale rather than rendering them as visible escaped text.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  // `output` is left at its default (`htmlAndMathml`) rather than pinned to
  // `'html'`. KaTeX marks its visual HTML tree `aria-hidden="true"` in every
  // output mode — it is designed to be paired with an accessible MathML
  // sibling, not to stand alone. Forcing `output: 'html'` would drop that
  // sibling and leave only the aria-hidden tree, so a screen reader would get
  // nothing at all for every formula, not a formula read twice.
  //
  // `errorColor` is set because KaTeX's default is the literal `#cc0000`,
  // emitted as an *inline* `style="color:…"` on `.katex-error`, which beats
  // every stylesheet and every one of the eleven palettes. The trigger surface
  // is ordinary authoring — an unbalanced brace, an unsupported command, and
  // every `\href`/`\url`/`\includegraphics`, all of which are error paths here
  // because `trust` is off. `--bad` is defined on `:root` and re-defined in all
  // ten `[data-palette]` blocks, so the error text follows the reader's choice.
  // The MathML `mathcolor` attribute cannot resolve a CSS variable, which is
  // harmless: `.katex-mathml` is visually hidden and exists for screen readers.
  .use(rehypeKatex, { errorColor: 'var(--bad)' })
  // `css-variables` emits var(--shiki-*) rather than baking a theme's colours
  // in. With eleven reader-selectable palettes a fixed theme would clash with
  // ten of them; this way code inherits whichever the reader picked, with no
  // JavaScript and no second stylesheet per palette.
  .use(rehypeShiki, {
    theme: cssVariablesTheme,
    langs: ['cpp', 'c', 'python', 'typescript', 'javascript', 'bash', 'json', 'html', 'css', 'yaml', 'markdown'],
    fallbackLanguage: 'text',
  })
  .use(rehypeSafeUrls)
  .use(rehypeStringify);

export async function renderMarkdown(body: string): Promise<string> {
  return String(await processor.process(body));
}
