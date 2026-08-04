import { canonicalPostTx } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';
import { merkleRootHex } from '../../src/chain/merkle';
import { mine } from '../../src/chain/mine';
import type { Block, Chain, Transaction } from '../../src/chain/types';

/**
 * Chains that are genuinely mined, for tests that need to tamper with one.
 *
 * A fixture that merely *looks* like a chain proves nothing about a verifier:
 * every hash here is a real SHA-256 over the same canonical forms the build
 * uses, and every block is really mined, so a fixture that stops verifying is
 * a real defect and not a fixture that drifted.
 *
 * Difficulty 2 rather than the chain's own 5 — mining is the only slow part of
 * these tests, and the difficulty a block commits to is itself what
 * `verifyBlock` checks proof of work against.
 */

export const DIFFICULTY = 2;
export const ZERO = '0x' + '00'.repeat(32);
/** A well-formed 20-byte address, so fixtures pass the structural shape check. */
const FROM = '0x' + 'aa'.repeat(20);

/** A post transaction whose hash genuinely commits to its own fields. */
export async function tx(slug: string, assets: string[] = []): Promise<Transaction> {
  const fields = {
    title: `Bài ${slug}`,
    date: '2026-07-01',
    tags: [],
    series: null,
    research: 1,
    from: FROM,
    contentHash: ZERO,
    assets,
  };
  return {
    hash: await sha256Hex(canonicalPostTx(fields)),
    type: 'post',
    slug,
    title: fields.title,
    date: fields.date,
    tags: fields.tags,
    series: fields.series,
    from: fields.from,
    to: [],
    contentHash: fields.contentHash,
    assets: fields.assets,
    gasUsed: 10,
    value: fields.research,
    research: null,
    amends: null,
  };
}

export async function makeBlock(
  height: number,
  prevHash: string,
  transactions: Transaction[],
  difficulty = DIFFICULTY,
): Promise<Block> {
  const merkleRoot = await merkleRootHex(transactions.map((t) => t.hash));
  const header = {
    height,
    prevHash,
    merkleRoot,
    timestamp: `2026-0${height + 1}-01T00:00:00Z`,
    txCount: transactions.length,
    gasUsed: transactions.reduce((s, t) => s + t.gasUsed, 0),
    difficulty,
  };
  const { nonce, hash } = mine(header, difficulty);
  return {
    ...header,
    nonce,
    hash,
    period: `2026-0${height + 1}`,
    value: transactions.reduce((s, t) => s + t.value, 0),
    transactions,
  };
}

/** Three sealed blocks, chained — long enough that "one at a time" is visible. */
export async function validChain(): Promise<Chain> {
  const b0 = await makeBlock(0, ZERO, [await tx('a')]);
  const b1 = await makeBlock(1, b0.hash, [await tx('b'), await tx('c')]);
  const b2 = await makeBlock(2, b1.hash, [await tx('d')]);
  return { version: 1, difficulty: DIFFICULTY, blocks: [b0, b1, b2], assets: [] };
}
