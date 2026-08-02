import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_CHAIN, serializeChain, readLock, writeLock } from '../../src/chain/lock';
import type { Chain } from '../../src/chain/types';

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'chain-')), name);
}

const chain: Chain = { version: 1, difficulty: 5, blocks: [] };

// Fixture with deliberately inconsistent difficulty to verify field-level serialization:
// chain.difficulty = 5, block.difficulty = 3. This is intentional — the fixture is used
// only for serialization testing and the distinct values ensure the test catches any
// confusion between levels.
const populated: Chain = {
  version: 1,
  difficulty: 5,
  blocks: [
    {
      height: 7,
      period: '2026-07',
      prevHash: '0x' + 'ab'.repeat(32),
      merkleRoot: '0x' + 'cd'.repeat(32),
      timestamp: '2026-07-31T00:00:00Z',
      txCount: 2,
      gasUsed: 2840,
      value: 12.5,
      difficulty: 3,
      nonce: 148203,
      hash: '0x' + 'ef'.repeat(32),
      transactions: [
        {
          hash: '0x' + '11'.repeat(32),
          type: 'post',
          slug: '2026-07-28-mo-algorithm',
          title: "Mo's Algorithm và cách tối ưu",
          date: '2026-07-28',
          tags: ['algorithm', 'cp'],
          series: 'ghi-chu-thuat-toan',
          from: '0x' + '22'.repeat(20),
          to: ['0x' + '33'.repeat(20), '0x' + '44'.repeat(20)],
          contentHash: '0x' + '55'.repeat(32),
          gasUsed: 1900,
          value: 9.5,
          amends: null,
        },
        {
          hash: '0x' + '66'.repeat(32),
          type: 'amendment',
          slug: null,
          title: null,
          date: '2026-06-15',
          tags: [],
          series: null,
          from: '0x' + '22'.repeat(20),
          to: [],
          contentHash: '0x' + '77'.repeat(32),
          gasUsed: 940,
          value: 2.8,
          amends: '0x' + '88'.repeat(32),
        },
      ],
    },
  ],
};

describe('EMPTY_CHAIN', () => {
  it('starts at version 1 with no blocks', () => {
    expect(EMPTY_CHAIN(5)).toEqual({ version: 1, difficulty: 5, blocks: [] });
  });
});

describe('serializeChain', () => {
  it('ends with exactly one trailing newline', () => {
    const out = serializeChain(chain);
    expect(out.endsWith('}\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('is stable across repeated calls', () => {
    expect(serializeChain(chain)).toBe(serializeChain(chain));
  });

  it('does not depend on key insertion order', () => {
    const reordered = { blocks: [], difficulty: 5, version: 1 } as unknown as Chain;
    expect(serializeChain(reordered)).toBe(serializeChain(chain));
  });

  it('is stable across repeated calls with populated blocks', () => {
    expect(serializeChain(populated)).toBe(serializeChain(populated));
  });

  it('does not depend on block/transaction key insertion order', () => {
    const block = populated.blocks[0]!;
    const tx0 = block.transactions[0]!;
    const tx1 = block.transactions[1]!;

    // Construct scrambled transactions with keys in deliberately different order
    const scrambledTx0 = {
      amends: tx0.amends,
      value: tx0.value,
      gasUsed: tx0.gasUsed,
      contentHash: tx0.contentHash,
      to: tx0.to,
      from: tx0.from,
      series: tx0.series,
      tags: tx0.tags,
      date: tx0.date,
      title: tx0.title,
      slug: tx0.slug,
      type: tx0.type,
      hash: tx0.hash,
    } as any;

    const scrambledTx1 = {
      amends: tx1.amends,
      value: tx1.value,
      gasUsed: tx1.gasUsed,
      contentHash: tx1.contentHash,
      to: tx1.to,
      from: tx1.from,
      series: tx1.series,
      tags: tx1.tags,
      date: tx1.date,
      title: tx1.title,
      slug: tx1.slug,
      type: tx1.type,
      hash: tx1.hash,
    } as any;

    const scrambled: Chain = {
      version: 1,
      difficulty: 5,
      blocks: [
        {
          transactions: [scrambledTx0, scrambledTx1],
          hash: block.hash,
          nonce: block.nonce,
          difficulty: block.difficulty,
          value: block.value,
          gasUsed: block.gasUsed,
          txCount: block.txCount,
          timestamp: block.timestamp,
          merkleRoot: block.merkleRoot,
          prevHash: block.prevHash,
          period: block.period,
          height: block.height,
        } as any,
      ],
    };
    expect(serializeChain(scrambled)).toBe(serializeChain(populated));
  });

  it('serializes all fields at each object level with correct key order', () => {
    const output = serializeChain(populated);
    const parsed = JSON.parse(output);

    // Verify chain-level keys and order
    const chainKeys = Object.keys(parsed);
    expect(chainKeys).toEqual(['version', 'difficulty', 'blocks']);

    // Verify block-level keys and order
    const block = parsed.blocks[0];
    const blockKeys = Object.keys(block);
    expect(blockKeys).toEqual([
      'height',
      'period',
      'prevHash',
      'merkleRoot',
      'timestamp',
      'txCount',
      'gasUsed',
      'value',
      'difficulty',
      'nonce',
      'hash',
      'transactions',
    ]);

    // Verify transaction-level keys and order for post transaction
    const postTx = block.transactions[0];
    const postTxKeys = Object.keys(postTx);
    expect(postTxKeys).toEqual([
      'hash',
      'type',
      'slug',
      'title',
      'date',
      'tags',
      'series',
      'from',
      'to',
      'contentHash',
      'gasUsed',
      'value',
      'amends',
    ]);

    // Verify transaction-level keys and order for amendment transaction
    const amendmentTx = block.transactions[1];
    const amendmentTxKeys = Object.keys(amendmentTx);
    expect(amendmentTxKeys).toEqual([
      'hash',
      'type',
      'slug',
      'title',
      'date',
      'tags',
      'series',
      'from',
      'to',
      'contentHash',
      'gasUsed',
      'value',
      'amends',
    ]);

    // Verify distinct field values to catch any level confusion
    expect(block.gasUsed).toBe(2840);
    expect(postTx.gasUsed).toBe(1900);
    expect(amendmentTx.gasUsed).toBe(940);

    expect(block.value).toBe(12.5);
    expect(postTx.value).toBe(9.5);
    expect(amendmentTx.value).toBe(2.8);

    // Verify difficulty at both levels (deliberately different to catch serialization confusion)
    expect(parsed.difficulty).toBe(5); // chain level
    expect(block.difficulty).toBe(3); // block level, distinct to verify no level confusion
  });
});

describe('readLock', () => {
  it('returns an empty chain when the file does not exist', () => {
    expect(readLock(tempFile('missing.json'), 5)).toEqual(EMPTY_CHAIN(5));
  });

  it('round-trips a written chain', () => {
    const path = tempFile('chain.lock.json');
    writeLock(path, chain);
    expect(readLock(path, 5)).toEqual(chain);
  });

  it('round-trips a populated chain with all fields intact', () => {
    const path = tempFile('populated.json');
    writeLock(path, populated);
    expect(readLock(path, 5)).toEqual(populated);
  });

  it('throws on malformed JSON rather than silently resetting the ledger', () => {
    const path = tempFile('broken.json');
    writeFileSync(path, '{ not json');
    expect(() => readLock(path, 5)).toThrow();
  });

  it('throws on an unknown version rather than guessing', () => {
    const path = tempFile('future.json');
    writeFileSync(path, JSON.stringify({ version: 99, difficulty: 5, blocks: [] }));
    expect(() => readLock(path, 5)).toThrow(/version/i);
  });

  it('throws when blocks array is missing from ledger', () => {
    const path = tempFile('missing-blocks.json');
    writeFileSync(path, JSON.stringify({ version: 1, difficulty: 5 }));
    expect(() => readLock(path, 5)).toThrow(/blocks/i);
  });

  it('throws when blocks is not an array', () => {
    const path = tempFile('invalid-blocks.json');
    writeFileSync(path, JSON.stringify({ version: 1, difficulty: 5, blocks: 'not an array' }));
    expect(() => readLock(path, 5)).toThrow(/blocks/i);
  });
});

describe('writeLock', () => {
  it('writes the serialized form verbatim', () => {
    const path = tempFile('chain.lock.json');
    writeLock(path, chain);
    expect(readFileSync(path, 'utf8')).toBe(serializeChain(chain));
  });
});
