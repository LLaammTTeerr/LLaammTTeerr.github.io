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
 * §3.2b — a single asset record's own shape, independent of whether it agrees
 * with the transactions. Exported for exactly the reason
 * `blockStructuralProblem` is: the Node-side lock reader and the browser-side
 * verifier must agree on what a valid record is, and two implementations of
 * "valid" drift the moment one of them is edited. Total over untrusted input —
 * returns a descriptive string or null, never throws, for `null`, a
 * non-object, or any missing or wrong-typed field.
 */
export function assetRecordProblem(rec: unknown): string | null {
  if (!isRecord(rec)) return 'is not an object';
  if (typeof rec.tokenId !== 'number' || !Number.isInteger(rec.tokenId) || rec.tokenId < 1) {
    return 'field "tokenId" is not a positive integer';
  }
  if (!isHexOfLength(rec.hash, 64)) {
    return 'field "hash" is not a 0x-prefixed 64-hex-digit string';
  }
  // `file` and `mime` are the two fields a page interpolates — `file` into an
  // `/assets/<file>` URL, `mime` into an attribute — and neither is committed
  // to any hash, so "non-empty string" is not a useful check on them. Require
  // instead exactly the shape the minting side can produce: `referencedAssets`
  // captures `[A-Za-z0-9._-]+` and `hashAssetFile` rejects `.` and `..`, and
  // `mimeTypeFor` returns a type/subtype from a fixed table. No honestly minted
  // record can fail this; a hand-edited `<script>` or `../../../etc/passwd`
  // cannot pass it.
  if (typeof rec.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(rec.file) || rec.file === '.' || rec.file === '..') {
    return 'field "file" is not a plain asset filename';
  }
  if (typeof rec.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rec.mime)) {
    return 'field "mime" is not a type/subtype media type';
  }
  if (typeof rec.bytes !== 'number' || !Number.isFinite(rec.bytes) || rec.bytes < 0) {
    return 'field "bytes" is not a non-negative number';
  }
  if (typeof rec.mintedIn !== 'number' || !Number.isInteger(rec.mintedIn) || rec.mintedIn < 0) {
    return 'field "mintedIn" is not a non-negative integer';
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
 *
 * Note the limit of what this proves: `file`, `mime` and `bytes` are committed
 * to no hash anywhere on the chain — only the asset's content hash is — so they
 * are shape-checked here but not authenticatable, and `/verify` reporting clean
 * says nothing about whether they were edited.
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
    const shape = assetRecordProblem(rec);
    if (shape !== null) return `asset #${i} ${shape}`;
    if (rec!.hash !== order[i]) return `asset #${i} is out of first-appearance order`;
    if (rec!.tokenId !== i + 1) return `asset #${i} has tokenId ${String(rec!.tokenId)}, expected ${i + 1}`;
    if (rec!.mintedIn !== firstSeen.get(order[i]!)) {
      return `asset ${order[i]} claims mintedIn ${String(rec!.mintedIn)} but first appears in block #${String(firstSeen.get(order[i]!))}`;
    }
  }
  return null;
}

export interface ChainVerification {
  ok: boolean;
  blocks: BlockVerification[];
  /**
   * Set only when the asset registry itself is inconsistent. Without it a
   * registry-only failure reports `ok: false` with every block green and no
   * stated cause anywhere — the worst failure state for a project whose whole
   * premise is legible verification.
   */
  registry?: string;
}

export async function verifyChain(chain: Chain): Promise<ChainVerification> {
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
  const ok = blocks.every((b) => b.ok) && registry === null;
  return registry === null ? { ok, blocks } : { ok, blocks, registry };
}
