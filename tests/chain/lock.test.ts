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
});

describe('writeLock', () => {
  it('writes the serialized form verbatim', () => {
    const path = tempFile('chain.lock.json');
    writeLock(path, chain);
    expect(readFileSync(path, 'utf8')).toBe(serializeChain(chain));
  });
});
