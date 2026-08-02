import { describe, it, expect } from 'vitest';
import {
  getChain, getBlocks, getBlock, getPosts, getAssets, getStats,
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
  // These pin concrete numbers from the committed ledger. Re-deriving the
  // expectation with the implementation's own expression cannot catch a
  // conceptual error — it passed happily while `height` reported the block
  // count (2) for a chain whose tip says #1, and while `transactions`
  // reported the post count under a tile labelled Transactions.
  it('reports the committed height of the tip, not the number of blocks', () => {
    expect(getChain().blocks).toHaveLength(2);
    expect(getStats().height).toBe(1);
    expect(getStats().height).toBe(getBlocks()[0]!.height);
  });

  it("counts every transaction from the headers' committed txCount", () => {
    // Amendments are transactions too (§3.9): committed to merkleRoot and
    // counted in txCount. A post count agrees only while the ledger holds
    // none, and would disagree with the block pages on the first one.
    const committed = getChain().blocks.reduce((n, b) => n + b.txCount, 0);
    expect(committed).toBe(1);
    expect(getStats().transactions).toBe(1);
    expect(getStats().transactions).toBe(committed);
  });

  it('counts the assets in the committed registry', () => {
    expect(getStats().assets).toBe(0);
    expect(getStats().assets).toBe(getChain().assets.length);
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

  // Pins a concrete number from the committed ledger rather than
  // re-deriving it with the same walk as the implementation — a shared
  // conceptual mistake in both would otherwise pass silently.
  it('counts exactly the two addresses in the committed ledger', () => {
    expect(getStats().addresses).toBe(2);
  });

  it('reports the chain difficulty', () => {
    expect(getStats().difficulty).toBe(5);
    expect(getStats().difficulty).toBe(getChain().difficulty);
  });
});

describe('cache immutability', () => {
  it('freezes the chain, its blocks, transactions, and asset registry', () => {
    const chain = getChain();
    expect(Object.isFrozen(chain)).toBe(true);
    expect(Object.isFrozen(chain.blocks)).toBe(true);
    expect(Object.isFrozen(chain.assets)).toBe(true);
    for (const block of chain.blocks) {
      expect(Object.isFrozen(block)).toBe(true);
      expect(Object.isFrozen(block.transactions)).toBe(true);
      for (const tx of block.transactions) expect(Object.isFrozen(tx)).toBe(true);
    }
  });

  it('throws rather than silently accepting a mutation on a returned transaction', () => {
    const post = getPosts()[0]!;
    const originalHash = post.hash;
    expect(() => {
      (post as { hash: string }).hash = 'mutated';
    }).toThrow(TypeError);
    // Not just "it threw" — the cache a later page reads must be unchanged.
    expect(getPosts()[0]!.hash).toBe(originalHash);
    expect(getChain().blocks.flatMap((b) => b.transactions)[0]!.hash).toBe(originalHash);
  });

  it("throws rather than silently accepting a mutation on a returned block's transactions array", () => {
    const block = getBlocks().find((b) => b.transactions.length > 0)!;
    const originalLength = block.transactions.length;
    expect(() => {
      block.transactions.push(block.transactions[0]!);
    }).toThrow(TypeError);
    expect(getBlock(block.height)!.transactions).toHaveLength(originalLength);
    expect(getChain().blocks.find((b) => b.height === block.height)!.transactions).toHaveLength(
      originalLength,
    );
  });

  it('throws rather than silently accepting a mutation on the frozen asset registry', () => {
    // The committed ledger mints no assets yet, so there is no individual
    // AssetRecord to attempt to mutate — but the array itself must still
    // reject a push, since that would poison every later page's asset list.
    const originalLength = getChain().assets.length;
    expect(() => {
      getChain().assets.push({
        tokenId: 999,
        hash: '0xdeadbeef',
        file: 'nonexistent.png',
        mime: 'image/png',
        bytes: 0,
        mintedIn: 0,
      });
    }).toThrow(TypeError);
    expect(getAssets()).toHaveLength(originalLength);
    expect(getChain().assets).toHaveLength(originalLength);
  });
});
