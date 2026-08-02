import type { Element, Parents, Root } from 'hast';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

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
  .use(remarkRehype)
  .use(rehypeSafeUrls)
  .use(rehypeStringify);

export async function renderMarkdown(body: string): Promise<string> {
  return String(await processor.process(body));
}
