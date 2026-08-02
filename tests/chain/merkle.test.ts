import { describe, it, expect } from 'vitest';
import { merkleRoot, merkleRootHex } from '../../src/chain/merkle';
import { sha256, toHex, fromHex } from '../../src/chain/hash';

/** Concatenate two digests, matching the tree's internal-node rule. */
function cat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe('merkleRoot', () => {
  it('returns 32 zero bytes for an empty set', async () => {
    const root = await merkleRoot([]);
    expect(root.length).toBe(32);
    expect(toHex(root)).toBe('00'.repeat(32));
  });

  it('returns the leaf itself for a single leaf', async () => {
    const a = await sha256('a');
    expect(toHex(await merkleRoot([a]))).toBe(toHex(a));
  });

  it('hashes the concatenation for two leaves', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    expect(toHex(await merkleRoot([a, b]))).toBe(toHex(await sha256(cat(a, b))));
  });

  it('duplicates the last node on an odd level (the Bitcoin rule)', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    const c = await sha256('c');
    const expected = await sha256(
      cat(await sha256(cat(a, b)), await sha256(cat(c, c))),
    );
    expect(toHex(await merkleRoot([a, b, c]))).toBe(toHex(expected));
  });

  it('is order-sensitive', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    expect(toHex(await merkleRoot([a, b]))).not.toBe(toHex(await merkleRoot([b, a])));
  });

  it('handles four leaves as a balanced tree', async () => {
    const [a, b, c, d] = await Promise.all(
      ['a', 'b', 'c', 'd'].map((s) => sha256(s)),
    );
    const expected = await sha256(
      cat(await sha256(cat(a!, b!)), await sha256(cat(c!, d!))),
    );
    expect(toHex(await merkleRoot([a!, b!, c!, d!]))).toBe(toHex(expected));
  });
});

describe('merkleRootHex', () => {
  it('accepts and returns 0x-prefixed hex', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    const root = await merkleRootHex(['0x' + toHex(a), '0x' + toHex(b)]);
    expect(root).toBe('0x' + toHex(await merkleRoot([a, b])));
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('agrees with the byte-level function on an empty set', async () => {
    expect(await merkleRootHex([])).toBe('0x' + '00'.repeat(32));
  });

  it('round-trips through fromHex', async () => {
    const a = await sha256('a');
    expect(toHex(fromHex('0x' + toHex(a)))).toBe(toHex(a));
  });
});
