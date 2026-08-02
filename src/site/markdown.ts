import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

/**
 * §6.1 — renders the verified body from `getPostContent`.
 *
 * `allowDangerousHtml` is deliberately off. A body is hashed into the chain,
 * which makes it tamper-evident, not safe: the author is still typing it, and
 * the page around it carries reader preferences and a verify control. Raw HTML
 * in a post is escaped rather than passed through.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

export async function renderMarkdown(body: string): Promise<string> {
  return String(await processor.process(body));
}
