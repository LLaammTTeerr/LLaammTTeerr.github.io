import { describe, it, expect } from 'vitest';
import { merkleRoot, merkleRootHex } from '../../src/chain/merkle';
import { sha256, sha256Hex, toHex, fromHex } from '../../src/chain/hash';
import { canonicalPostTx } from '../../src/chain/canonical';
import { verifyBlock } from '../../src/chain/verify';
import { ZERO, makeBlock, tx } from './chain-fixture';
import type { Transaction } from '../../src/chain/types';

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

  it('produces the same root for [a,b,c] and [a,b,c,c] — the malleability the rule brings', async () => {
    // CVE-2012-2459, stated at the level of the tree. The Bitcoin odd-node rule
    // duplicates the trailing node, so a list whose last element is already
    // duplicated hashes to a root byte-identical to the shorter list's. This is
    // not a defect in `merkleRoot` — it is the rule §3.3 chose, faithfully
    // implemented — but it is the reason the block-level test below has to
    // exist, and the reason nobody may "simplify" the defence it pins.
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map((s) => sha256(s)));
    expect(toHex(await merkleRoot([a!, b!, c!]))).toBe(toHex(await merkleRoot([a!, b!, c!, c!])));
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

/**
 * CVE-2012-2459, at the level this chain actually has to survive it.
 *
 * §3.3 adopts the Bitcoin odd-node rule, and the rule brings the Bitcoin
 * malleability with it: duplicating a block's **trailing** transaction leaves
 * the Merkle root byte-identical, so `merkleOk` cannot see it, the header is
 * untouched so the mined hash still recomputes, and the proof of work still
 * stands. On this chain the forgery is caught by exactly one clause of one
 * expression in `verifyBlock`:
 *
 *     const hashOk = expectedHash === block.hash && block.txCount === block.transactions.length;
 *
 * That clause had no test. Deleting it left the whole relevant suite green
 * (171/171), which is one careless simplification away from a ledger that shows
 * a post twice in a block, inflates the transaction count on every listing, and
 * verifies clean. These two tests exist so that deletion turns something red.
 */
describe('a duplicated trailing transaction (CVE-2012-2459)', () => {
  /**
   * A block whose last transaction carries no gas and no value, then duplicated
   * in place — `txCount`, `merkleRoot`, `nonce` and `hash` all left alone.
   *
   * The trailing transaction has to be gas-free for this to be the *pure*
   * forgery. `transactionsOk` re-sums `gasUsed` and `value` over the
   * transaction list, so duplicating a transaction that carries either would
   * be caught a second time, by `txOk`, and the test would then pass with the
   * `txCount` clause deleted — proving nothing about the clause it exists for.
   * The real chain has such transactions: an amendment's gas and value are
   * fixed at 0 by §3.9, which is why the reviewer reproduced this on block #4
   * with `txOk: true`.
   */
  async function forged(): Promise<{ block: Awaited<ReturnType<typeof makeBlock>>; honest: Awaited<ReturnType<typeof makeBlock>> }> {
    const free = await tx('mien-phi');
    const zeroGas: Transaction = {
      ...free,
      gasUsed: 0,
      value: 0,
      hash: await sha256Hex(
        canonicalPostTx({
          title: free.title!,
          date: free.date,
          tags: free.tags,
          series: free.series,
          research: 0,
          from: free.from,
          contentHash: free.contentHash,
          assets: free.assets,
        }),
      ),
    };
    // Three, so the odd-node rule is the one in play.
    const honest = await makeBlock(0, ZERO, [await tx('mot'), await tx('hai'), zeroGas]);
    const block = { ...honest, transactions: [...honest.transactions, zeroGas] };
    return { block, honest };
  }

  it('leaves the Merkle root, the header hash and the proof of work all intact', async () => {
    // The anti-vacuity half, and the one that makes the next test mean
    // something: if any of these three had gone false, the forgery would be
    // caught by a check other than the one under test and the pin below would
    // pass for the wrong reason.
    const { block, honest } = await forged();
    expect(block.transactions).toHaveLength(4);
    expect(block.txCount, 'the forgery must not touch txCount').toBe(3);
    expect(
      await merkleRootHex(block.transactions.map((t) => t.hash)),
      'the duplicated trailing transaction changed the root, so this is not the CVE shape',
    ).toBe(honest.merkleRoot);

    const result = await verifyBlock(block, null, 2);
    expect(result.reason).toBeUndefined();
    expect(result.merkleOk, 'the root still rebuilds — merkleOk cannot see this forgery').toBe(true);
    expect(result.powOk, 'the header is untouched, so the work still stands').toBe(true);
    expect(result.txOk, 'the sums are unchanged, so txOk cannot see this forgery either').toBe(true);
    expect(result.linkOk).toBe(true);
  });

  it('is caught by hashOk, and by nothing else — the txCount clause is the whole defence', async () => {
    const { block } = await forged();
    const result = await verifyBlock(block, null, 2);
    expect(result.hashOk, 'txCount no longer counts the transactions, and hashOk said nothing').toBe(false);
    expect(result.ok).toBe(false);
  });

  it('accepts the same block unforged, so the assertion above is not trivially true', async () => {
    const { honest } = await forged();
    const result = await verifyBlock(honest, null, 2);
    expect(result.hashOk).toBe(true);
    expect(result.ok).toBe(true);
  });
});
