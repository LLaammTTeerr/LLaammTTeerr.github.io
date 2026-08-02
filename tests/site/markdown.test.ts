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

  it('escapes raw HTML rather than passing it through', async () => {
    // Bodies are hashed into the chain, but a body is still author input and
    // the rendered page carries reader preferences and a verify control.
    const html = await renderMarkdown('<script>alert(1)</script>\n');
    expect(html).not.toContain('<script>');
  });

  it('is deterministic', async () => {
    const md = '# Tiêu đề\n\nmột đoạn văn.\n';
    expect(await renderMarkdown(md)).toBe(await renderMarkdown(md));
  });
});
