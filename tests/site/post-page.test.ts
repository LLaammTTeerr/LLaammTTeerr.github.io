import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { getBlocks, getPosts } from '../../src/site/chain-data';

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
    // Anchored to the panel's own head markup, not a bare substring: the
    // nav's "Transactions" link (present on every page via Base.astro)
    // would otherwise satisfy a bare toContain('Transaction') even if
    // TxPanel rendered nothing at all.
    expect(page()).toContain('<span class="lbl">Transaction</span>');
  });

  it('names the block the post was sealed in', () => {
    // Derived from the chain, not hard-coded, and anchored to the exact
    // link markup TxPanel renders — a bare /Block/ regex would (and did)
    // pass on any page, since Base.astro's nav renders a "Blocks" link
    // regardless of whether TxPanel names a block at all.
    const tx = getPosts()[0]!;
    const block = getBlocks().find((b) => b.transactions.some((t) => t.hash === tx.hash))!;
    expect(page()).toContain(`<a href="/block/${block.height}">#${block.height}</a>`);
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
    // Anchored to the panel's own <span class="num"> markup. A bare
    // toContain(String(tx.gasUsed)) passed even with TxPanel's gas/value
    // spans deleted entirely: the same digits are echoed in the page's
    // <meta description> (built from tx.gasUsed independently) and can
    // also coincide with digits inside the tx hash printed just above.
    const tx = getPosts()[0]!;
    expect(page()).toContain(`<span class="num">${tx.gasUsed}</span>`);
    expect(page()).toContain(`<span class="num">${tx.value.toFixed(1)}</span>`);
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
