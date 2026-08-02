import { describe, it, expect } from 'vitest';
import { verifyChain } from '../../src/chain/verify';
import { merkleRootHex } from '../../src/chain/merkle';
import { mine } from '../../src/chain/mine';
import type { Block, Chain, Transaction } from '../../src/chain/types';

const DIFFICULTY = 2;
const ZERO = '0x' + '00'.repeat(32);

function tx(slug: string): Transaction {
  return {
    hash: '0x' + slug.repeat(64).slice(0, 64),
    type: 'post',
    slug,
    title: slug,
    date: '2026-07-01',
    tags: [],
    series: null,
    from: '0xaaaa',
    to: [],
    contentHash: ZERO,
    gasUsed: 10,
    value: 1,
    amends: null,
  };
}

async function makeBlock(
  height: number,
  prevHash: string,
  transactions: Transaction[],
): Promise<Block> {
  const merkleRoot = await merkleRootHex(transactions.map((t) => t.hash));
  const header = {
    height,
    prevHash,
    merkleRoot,
    timestamp: `2026-0${height + 1}-01T00:00:00Z`,
    txCount: transactions.length,
    gasUsed: transactions.reduce((s, t) => s + t.gasUsed, 0),
    difficulty: DIFFICULTY,
  };
  const { nonce, hash } = mine(header, DIFFICULTY);
  return {
    ...header,
    nonce,
    hash,
    period: `2026-0${height + 1}`,
    value: transactions.reduce((s, t) => s + t.value, 0),
    transactions,
  };
}

async function validChain(): Promise<Chain> {
  const b0 = await makeBlock(0, ZERO, [tx('a')]);
  const b1 = await makeBlock(1, b0.hash, [tx('b'), tx('c')]);
  return { version: 1, difficulty: DIFFICULTY, blocks: [b0, b1] };
}

describe('verifyChain', () => {
  it('accepts a well-formed chain', async () => {
    const result = await verifyChain(await validChain());
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.every((b) => b.ok)).toBe(true);
  });

  it('accepts an empty block', async () => {
    const b0 = await makeBlock(0, ZERO, []);
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [b0] });
    expect(result.ok).toBe(true);
  });

  it('accepts a chain with no blocks', async () => {
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [] });
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  it('detects a tampered transaction via the merkle root', async () => {
    const chain = await validChain();
    chain.blocks[1]!.transactions[0]!.hash = '0x' + 'f'.repeat(64);
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.merkleOk).toBe(false);
  });

  it('detects a tampered block header via the block hash', async () => {
    const chain = await validChain();
    chain.blocks[0]!.gasUsed = 999999;
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.hashOk).toBe(false);
  });

  it('detects a broken prev-hash link', async () => {
    const chain = await validChain();
    chain.blocks[1]!.prevHash = '0x' + 'e'.repeat(64);
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.linkOk).toBe(false);
  });

  it('requires the genesis block to link to zero', async () => {
    const chain = await validChain();
    chain.blocks[0]!.prevHash = '0x' + '11'.repeat(32);
    const result = await verifyChain(chain);
    expect(result.blocks[0]!.linkOk).toBe(false);
  });

  it('detects a hash that does not meet the stated difficulty', async () => {
    const chain = await validChain();
    const result = await verifyChain({ ...chain, difficulty: 8 });
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.powOk).toBe(false);
  });

  it('detects a non-contiguous height', async () => {
    const chain = await validChain();
    chain.blocks[1]!.height = 5;
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
  });
});

import { readFileSync } from 'node:fs';

describe('browser safety', () => {
  it('verify.ts and its transitive chain deps never import node:crypto', () => {
    for (const file of ['verify.ts', 'hash.ts', 'merkle.ts', 'canonical.ts', 'types.ts']) {
      const source = readFileSync(`src/chain/${file}`, 'utf8');
      expect(source, `${file} must stay browser-safe`).not.toContain('node:');
    }
  });
});
