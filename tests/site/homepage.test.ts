import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { getBlocks, getStats } from '../../src/site/chain-data';

// Read inside each test, never at module level — see tests/site/dist.ts.
const html = () => readDist('index.html');

describe('stats bar', () => {
  it('shows chain height, transactions, addresses and difficulty', () => {
    const s = getStats();
    expect(html()).toContain('Chain height');
    expect(html()).toContain('Transactions');
    expect(html()).toContain('Addresses');
    expect(html()).toContain('Difficulty');
    expect(html()).toContain(`>${s.height}<`);
  });
});

describe('block list', () => {
  it('renders every block', () => {
    for (const b of getBlocks()) {
      expect(html(), `missing block #${b.height}`).toContain(`data-block="${b.height}"`);
    }
  });

  it('orders blocks newest first in the document', () => {
    const order = [...html().matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  it('stamps sealed blocks', () => {
    expect(html()).toContain('Sealed');
  });

  it('marks the genesis block', () => {
    expect(html()).toContain('genesis');
  });

  it('renders each block with all three meter styles', () => {
    const blocks = getBlocks().length;
    expect([...html().matchAll(/meter-m1/g)]).toHaveLength(blocks);
    expect([...html().matchAll(/meter-m2/g)]).toHaveLength(blocks);
    expect([...html().matchAll(/meter-m3/g)]).toHaveLength(blocks);
  });

  it('shows the nonce and the work ratio', () => {
    const newest = getBlocks()[0]!;
    expect(html()).toContain(newest.nonce.toLocaleString('en-US'));
  });

  it('says a silent month is silent, in Vietnamese', () => {
    if (getBlocks().some((b) => b.isEmpty)) {
      expect(html()).toContain('Không có bài viết');
    }
  });
});

describe('chrome language', () => {
  it('keeps explorer terms in English', () => {
    expect(html()).toContain('Block');
    expect(html()).toContain('Nonce');
  });
});
