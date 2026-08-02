import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/site/markdown';

describe('renderMarkdown', () => {
  it('renders a paragraph', async () => {
    expect(await renderMarkdown('xin chào\n')).toContain('<p>xin chào</p>');
  });

  it('renders headings', async () => {
    expect(await renderMarkdown('## Ý tưởng\n')).toMatch(/<h2[^>]*>Ý tưởng<\/h2>/);
  });

  it('renders Vietnamese without mangling diacritics', async () => {
    const html = await renderMarkdown('Khối đầu tiên — ghi chú thuật toán\n');
    expect(html).toContain('Khối đầu tiên');
    expect(html).toContain('ghi chú thuật toán');
  });

  it('renders GFM tables', async () => {
    const html = await renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders inline code', async () => {
    expect(await renderMarkdown('dùng `O(n log n)`\n')).toContain('<code>O(n log n)</code>');
  });

  it('renders links', async () => {
    expect(await renderMarkdown('[x](/tx/abc)\n')).toContain('href="/tx/abc"');
  });

  it('drops raw HTML rather than passing it through', async () => {
    // Bodies are hashed into the chain, but a body is still author input and
    // the rendered page carries reader preferences and a verify control.
    const html = await renderMarkdown('<script>alert(1)</script>\n');
    expect(html).not.toContain('<script>');
  });

  it('is deterministic', async () => {
    const md = '# Tiêu đề\n\nmột đoạn văn.\n';
    expect(await renderMarkdown(md)).toBe(await renderMarkdown(md));
  });

  describe('unsafe URL protocols', () => {
    // Dropping raw author HTML but passing through a `javascript:` href would
    // be an inconsistent application of the same rationale: a body hashed
    // into the chain is tamper-evident, not safe, and the page around it
    // carries reader preferences and a verify control either way.

    it('unwraps a javascript: link to its plain text, not just stripping href', async () => {
      // A hrefless `<a>` isn't reliably inert to assistive tech, so the
      // element itself is unwrapped rather than left in place with the
      // attribute removed.
      const html = await renderMarkdown('[x](javascript:alert(1))\n');
      expect(html).toBe('<p>x</p>');
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toContain('<a');
    });

    it('unwraps a javascript: link regardless of case', async () => {
      const html = await renderMarkdown('[x](JaVaScRiPt:alert(1))\n');
      expect(html).toBe('<p>x</p>');
      expect(html).not.toMatch(/javascript:/i);
    });

    it('unwraps a data: link', async () => {
      const html = await renderMarkdown('[x](data:text/html,<script>alert(1)</script>)\n');
      expect(html).toBe('<p>x</p>');
      expect(html).not.toMatch(/data:/i);
    });

    it('drops a javascript: image, not just its src', async () => {
      // An <img> has no text children, so unwrapping it leaves nothing.
      const html = await renderMarkdown('![x](javascript:alert(1))\n');
      expect(html).toBe('<p></p>');
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toContain('<img');
    });

    it('keeps a site-relative link intact', async () => {
      expect(await renderMarkdown('[x](/tx/abc)\n')).toContain('href="/tx/abc"');
    });

    it('keeps an https link intact', async () => {
      expect(await renderMarkdown('[x](https://example.com)\n')).toContain(
        'href="https://example.com"'
      );
    });

    it('keeps a mailto link intact', async () => {
      expect(await renderMarkdown('[x](mailto:a@b.c)\n')).toContain('href="mailto:a@b.c"');
    });

    it('keeps a protocol-relative link intact', async () => {
      // No explicit scheme to check, so it inherits the page's own protocol —
      // this is a deliberate choice, not an oversight, and worth a test so a
      // future refactor can't silently flip it either way.
      expect(await renderMarkdown('[x](//example.com/a)\n')).toContain(
        'href="//example.com/a"'
      );
    });
  });

  describe('math', () => {
    it('renders inline math', async () => {
      const html = await renderMarkdown('độ phức tạp $O(n)$ là đủ\n');
      expect(html).toContain('katex');
      expect(html).not.toContain('$O(n)$');
    });

    it('renders display math', async () => {
      // remark-math's block ("display") form mirrors code-fence grammar: the
      // `$$` markers must sit alone on their own line. `$$...$$` on a single
      // line parses as *inline* math instead (its content permits a literal
      // `$`), so it never gets the `katex-display` class this test checks for.
      const html = await renderMarkdown('$$\nO((n + q)\\sqrt{n})\n$$\n');
      expect(html).toContain('katex-display');
    });

    it('leaves a lone dollar sign alone', async () => {
      // Prices and shell prompts must not become math.
      const html = await renderMarkdown('giá 5 $ một cái\n');
      expect(html).not.toContain('katex');
    });

    it('does not treat code blocks as math', async () => {
      const html = await renderMarkdown('```\ncost = $total\n```\n');
      expect(html).not.toContain('katex');
    });
  });
});
