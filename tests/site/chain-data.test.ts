import { describe, it, expect } from 'vitest';
import {
  getChain, getBlocks, getBlock, getPosts, getStats,
  workRatio, expectedAttempts,
} from '../../src/site/chain-data';

describe('expectedAttempts', () => {
  it('is 16^difficulty', () => {
    expect(expectedAttempts(1)).toBe(16);
    expect(expectedAttempts(5)).toBe(1048576);
  });
});

describe('workRatio', () => {
  it('is nonce over expected attempts', () => {
    expect(workRatio(1048576, 5)).toBeCloseTo(1, 6);
    expect(workRatio(2097152, 5)).toBeCloseTo(2, 6);
  });

  it('reports a lucky block as under one', () => {
    expect(workRatio(198676, 5)).toBeLessThan(1);
  });
});

describe('getChain', () => {
  it('reads the committed ledger', () => {
    const chain = getChain();
    expect(chain.version).toBe(1);
    expect(Array.isArray(chain.blocks)).toBe(true);
    expect(Array.isArray(chain.assets)).toBe(true);
  });

  it('returns the same object on repeated calls', () => {
    expect(getChain()).toBe(getChain());
  });
});

describe('getBlocks', () => {
  it('returns blocks newest first', () => {
    const heights = getBlocks().map((b) => b.height);
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
  });

  it('includes every block', () => {
    expect(getBlocks()).toHaveLength(getChain().blocks.length);
  });

  it('carries presentation fields', () => {
    const newest = getBlocks()[0]!;
    expect(typeof newest.isGenesis).toBe('boolean');
    expect(typeof newest.isEmpty).toBe('boolean');
    expect(typeof newest.workRatio).toBe('number');
    expect(newest.shortHash).toMatch(/^0x[0-9a-f]{6}…[0-9a-f]{6}$/);
  });

  it('marks the genesis block and only the genesis block', () => {
    const flagged = getBlocks().filter((b) => b.isGenesis);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.height).toBe(0);
  });

  it('marks an empty block by transaction count', () => {
    for (const b of getBlocks()) {
      expect(b.isEmpty).toBe(b.transactions.length === 0);
    }
  });
});

describe('getBlock', () => {
  it('finds a block by height', () => {
    expect(getBlock(0)?.height).toBe(0);
  });

  it('returns undefined for a height that does not exist', () => {
    expect(getBlock(9999)).toBeUndefined();
  });
});

describe('getPosts', () => {
  it('excludes amendments', () => {
    expect(getPosts().every((t) => t.type === 'post')).toBe(true);
  });

  it('returns posts newest first by date', () => {
    const dates = getPosts().map((p) => p.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe('getStats', () => {
  it('counts blocks, post transactions and assets', () => {
    const s = getStats();
    expect(s.height).toBe(getChain().blocks.length);
    expect(s.transactions).toBe(getPosts().length);
    expect(s.assets).toBe(getChain().assets.length);
  });

  it('counts distinct addresses across from and to', () => {
    const seen = new Set<string>();
    for (const b of getChain().blocks) {
      for (const t of b.transactions) {
        seen.add(t.from);
        for (const to of t.to) seen.add(to);
      }
    }
    expect(getStats().addresses).toBe(seen.size);
  });

  it('reports the chain difficulty', () => {
    expect(getStats().difficulty).toBe(getChain().difficulty);
  });
});
