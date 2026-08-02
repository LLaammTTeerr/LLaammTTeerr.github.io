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
      difficulty: 5,
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
          gasUsed: 2840,
          value: 12.5,
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
          gasUsed: 0,
          value: 0,
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
    const scrambled: Chain = {
      version: 1,
      difficulty: 5,
      blocks: [
        {
          transactions: block.transactions,
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

  it('includes all field names in serialized output', () => {
    const output = serializeChain(populated);
    const expectedFields = [
      'version',
      'difficulty',
      'blocks',
      'height',
      'period',
      'prevHash',
      'merkleRoot',
      'timestamp',
      'txCount',
      'gasUsed',
      'value',
      'nonce',
      'hash',
      'transactions',
      'type',
      'slug',
      'title',
      'date',
      'tags',
      'series',
      'from',
      'to',
      'contentHash',
      'amends',
    ];
    for (const field of expectedFields) {
      expect(output).toContain(`"${field}"`);
    }
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
