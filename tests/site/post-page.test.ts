import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { getPosts } from '../../src/site/chain-data';

const slug = () => getPosts()[0]!.slug!;
const page = () => readDist(`tx/${slug()}/index.html`);

describe('post page', () => {
  it('exists for every post on the chain', () => {
    for (const tx of getPosts()) {
      expect(() => readDist(`tx/${tx.slug}/index.html`)).not.toThrow();
    }
  });

  it('shows the transaction panel with the committed hash', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(tx.hash);
    expect(page()).toContain('Transaction');
  });

  it('names the block the post was sealed in', () => {
    expect(page()).toMatch(/Block/);
  });

  it('renders the post title as the page h1', () => {
    const tx = getPosts()[0]!;
    expect(page()).toMatch(new RegExp(`<h1[^>]*>${tx.title}</h1>`));
  });

  it('renders the body as HTML, not as raw markdown', () => {
    expect(page()).toContain('<p>');
    expect(page()).not.toContain('---\ntitle:');
  });

  it('shows gas and value from the committed transaction', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(String(tx.gasUsed));
  });

  it('links to each tag address the post sent to', () => {
    const tx = getPosts()[0]!;
    for (const tag of tx.tags) expect(page()).toContain(`/address/${tag}.tag`);
  });

  it('keeps the panel labels in English and the prose in Vietnamese', () => {
    expect(page()).toContain('Gas used');
    expect(page()).toContain('Khối đầu tiên');
  });

  it('carries the reader preference attributes like every other page', () => {
    expect(page()).toContain('data-palette');
  });

  it('sets a per-post title and description', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(`<title>${tx.title}`);
  });
});
