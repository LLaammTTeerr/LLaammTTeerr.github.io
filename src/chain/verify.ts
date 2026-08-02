import { canonicalAmendmentTx, canonicalBlockHeader, canonicalPostTx } from './canonical';
import { sha256Hex } from './hash';
import { merkleRootHex } from './merkle';
import type { Block, Chain, Hex, Transaction } from './types';

const ZERO_HASH = '0x' + '00'.repeat(32);

/** A hash is 64 hex characters, so no honest block can demand more zeros. */
const MAX_DIFFICULTY = 64;

export interface BlockVerification {
  height: number;
  hashOk: boolean;
  merkleOk: boolean;
  linkOk: boolean;
  powOk: boolean;
  /** Every transaction hash recomputes, and the block's gas/value sums match. */
  txOk: boolean;
  ok: boolean;
  /** Set only when the block is structurally invalid and could not be checked. */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** `0x` followed by exactly `len` lowercase hex digits. */
function isHexOfLength(value: unknown, len: number): boolean {
  return typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${len}}$`).test(value);
}

function transactionProblem(tx: unknown, index: number): string | null {
  const at = `transaction #${index}`;
  if (!isRecord(tx)) return `${at} is not an object`;
  if (!isHexOfLength(tx.hash, 64)) {
    return `${at} field "hash" is not a 0x-prefixed 64-hex-digit string`;
  }
  if (tx.type !== 'post' && tx.type !== 'amendment') {
    return `${at} field "type" is not "post" or "amendment"`;
  }
  if (typeof tx.date !== 'string') return `${at} field "date" is not a string`;
  if (!isHexOfLength(tx.from, 40)) {
    return `${at} field "from" is not a 0x-prefixed 40-hex-digit string`;
  }
  if (!isHexOfLength(tx.contentHash, 64)) {
    return `${at} field "contentHash" is not a 0x-prefixed 64-hex-digit string`;
  }
  if (!Array.isArray(tx.assets)) return `${at} field "assets" is not an array`;
  for (const a of tx.assets) {
    if (!isHexOfLength(a, 64)) {
      return `${at} has an asset hash that is not a 0x-prefixed 64-hex-digit string`;
    }
  }
  for (const field of ['slug', 'title', 'series', 'amends']) {
    if (!isStringOrNull(tx[field])) return `${at} field "${field}" is not a string or null`;
  }
  for (const field of ['gasUsed', 'value']) {
    if (!isFiniteNumber(tx[field])) return `${at} field "${field}" is not a finite number`;
  }
  if (tx.research != null && !isFiniteNumber(tx.research)) {
    return `${at} field "research" is not a finite number or null`;
  }
  if (!Array.isArray(tx.tags) || tx.tags.some((t) => typeof t !== 'string')) {
    return `${at} field "tags" is not an array of strings`;
  }
  if (!Array.isArray(tx.to) || tx.to.some((t) => typeof t !== 'string')) {
    return `${at} field "to" is not an array of strings`;
  }
  return null;
}

/**
 * §10 — describe a structurally broken block instead of crashing on it. In the
 * browser every byte of `chain.json` is untrusted: a truncated or hand-edited
 * ledger must surface as a reported failure, never as an uncaught TypeError
 * inside the verifier island. Exported so the Node-side lock reader validates
 * against exactly the same shape.
 */
export function blockStructuralProblem(block: unknown): string | null {
  if (!isRecord(block)) return 'block is not an object';
  for (const field of ['height', 'txCount', 'gasUsed', 'value', 'difficulty', 'nonce']) {
    if (!isFiniteNumber(block[field])) return `field "${field}" is not a finite number`;
  }
  const difficulty = block.difficulty as number;
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_DIFFICULTY) {
    return `field "difficulty" must be an integer in 0..${MAX_DIFFICULTY}, got ${difficulty}`;
  }
  for (const field of ['period', 'prevHash', 'merkleRoot', 'timestamp', 'hash']) {
    if (typeof block[field] !== 'string') return `field "${field}" is not a string`;
  }
  if (!Array.isArray(block.transactions)) return 'field "transactions" is not an array';
  for (const [index, tx] of block.transactions.entries()) {
    const problem = transactionProblem(tx, index);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * Recompute a transaction's hash from the fields the ledger records. Returns
 * null when the record cannot produce a canonical form at all, which is itself
 * a verification failure.
 */
async function expectedTxHash(tx: Transaction): Promise<Hex | null> {
  if (tx.type === 'post') {
    if (tx.title === null) return null;
    return sha256Hex(
      canonicalPostTx({
        title: tx.title,
        date: tx.date,
        tags: tx.tags,
        series: tx.series,
        // §3.8 — a post's declared research hours ARE its value.
        research: tx.value,
        from: tx.from,
        contentHash: tx.contentHash,
        assets: tx.assets,
      }),
    );
  }
  if (tx.title === null || tx.amends === null || tx.research == null) return null;
  return sha256Hex(
    canonicalAmendmentTx({
      amends: tx.amends,
      date: tx.date,
      title: tx.title,
      tags: tx.tags,
      series: tx.series,
      research: tx.research,
      from: tx.from,
      contentHash: tx.contentHash,
      assets: tx.assets,
    }),
  );
}

/**
 * The Merkle root only proves the *recorded* transaction hashes. Without this,
 * rewriting a transaction's title and value and leaving its hash alone passes
 * every other check — a verifier that reports clean on a forged post is worse
 * than none at all.
 */
async function transactionsOk(block: Block): Promise<boolean> {
  for (const tx of block.transactions) {
    const expected = await expectedTxHash(tx);
    if (expected === null || expected !== tx.hash) return false;
  }
  const gas = block.transactions.reduce((s, t) => s + t.gasUsed, 0);
  const value = block.transactions.reduce((s, t) => s + t.value, 0);
  return block.gasUsed === gas && block.value === Number(value.toFixed(1));
}

/**
 * §7 — pure verification, imported by both the build and the browser.
 * It must never gain a Node-only dependency.
 *
 * `difficulty` is the chain's declared floor; proof of work itself is checked
 * against the difficulty committed in the block's own mined header, so a chain
 * whose blocks were mined at different targets still verifies.
 */
export async function verifyBlock(
  block: Block,
  prev: Block | null,
  difficulty: number,
): Promise<BlockVerification> {
  const problem = blockStructuralProblem(block);
  if (problem !== null) {
    const height = isRecord(block) && isFiniteNumber(block.height) ? (block.height as number) : -1;
    return {
      height,
      hashOk: false,
      merkleOk: false,
      linkOk: false,
      powOk: false,
      txOk: false,
      ok: false,
      reason: problem,
    };
  }

  const expectedHash = await sha256Hex(
    canonicalBlockHeader({
      height: block.height,
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      timestamp: block.timestamp,
      txCount: block.txCount,
      gasUsed: block.gasUsed,
      difficulty: block.difficulty,
      nonce: block.nonce,
    }),
  );
  const expectedRoot = await merkleRootHex(block.transactions.map((t) => t.hash));

  const hashOk = expectedHash === block.hash && block.txCount === block.transactions.length;
  const merkleOk = expectedRoot === block.merkleRoot;
  const linkOk =
    prev === null
      ? block.prevHash === ZERO_HASH && block.height === 0
      : block.prevHash === prev.hash && block.height === prev.height + 1;
  const powOk =
    block.hash.startsWith('0x' + '0'.repeat(block.difficulty)) && block.difficulty >= difficulty;
  const txOk = await transactionsOk(block);

  return {
    height: block.height,
    hashOk,
    merkleOk,
    linkOk,
    powOk,
    txOk,
    ok: hashOk && merkleOk && linkOk && powOk && txOk,
  };
}

/**
 * §3.2b — the asset registry is derived data outside the mined header, so it
 * needs its own check: every referenced hash has exactly one entry, every
 * entry is referenced, mint blocks match first appearance, and token ids run
 * 1..n in that same order. Total over untrusted input, like the rest of this
 * module.
 */
function registryProblem(chain: Chain): string | null {
  if (!Array.isArray(chain.assets)) return 'assets is not an array';

  const firstSeen = new Map<Hex, number>();
  const order: Hex[] = [];
  for (const block of chain.blocks) {
    // A block that is not even an object (e.g. `null`) already fails
    // structurally and drags `ok` to false on its own; this loop must still
    // not throw walking past it to look for asset references.
    if (!isRecord(block) || !Array.isArray(block.transactions)) continue;
    for (const tx of block.transactions) {
      if (!isRecord(tx) || !Array.isArray(tx.assets)) continue;
      for (const hash of tx.assets) {
        if (typeof hash !== 'string' || firstSeen.has(hash)) continue;
        firstSeen.set(hash, isFiniteNumber(block.height) ? (block.height as number) : NaN);
        order.push(hash);
      }
    }
  }

  if (chain.assets.length !== order.length) {
    return `registry holds ${chain.assets.length} assets but transactions reference ${order.length}`;
  }
  for (let i = 0; i < order.length; i++) {
    const rec = chain.assets[i];
    if (!rec || typeof rec !== 'object') return `asset #${i} is not a record`;
    if (rec.hash !== order[i]) return `asset #${i} is out of first-appearance order`;
    if (rec.tokenId !== i + 1) return `asset #${i} has tokenId ${String(rec.tokenId)}, expected ${i + 1}`;
    if (rec.mintedIn !== firstSeen.get(order[i]!)) {
      return `asset ${order[i]} claims mintedIn ${String(rec.mintedIn)} but first appears in block #${String(firstSeen.get(order[i]!))}`;
    }
  }
  return null;
}

export async function verifyChain(
  chain: Chain,
): Promise<{ ok: boolean; blocks: BlockVerification[] }> {
  if (!isRecord(chain) || !Array.isArray(chain.blocks)) {
    return { ok: false, blocks: [] };
  }
  const difficulty = isFiniteNumber(chain.difficulty) ? chain.difficulty : 0;

  const blocks: BlockVerification[] = [];
  let prev: Block | null = null;
  for (const block of chain.blocks) {
    const result = await verifyBlock(block, prev, difficulty);
    blocks.push(result);
    // A structurally broken block cannot be a parent: leave `prev` in place so
    // the next block reports a link failure rather than crashing on it.
    if (result.reason === undefined) prev = block;
  }
  const registry = registryProblem(chain);
  return { ok: blocks.every((b) => b.ok) && registry === null, blocks };
}
