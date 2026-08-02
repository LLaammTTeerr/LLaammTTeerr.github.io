import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AssetRecord, Block, Chain, Transaction } from './types';
import { assetRecordProblem, blockStructuralProblem } from './verify';

export function emptyChain(difficulty: number): Chain {
  return { version: 1, difficulty, blocks: [], assets: [] };
}

/**
 * Serialize with an explicit key order so the committed ledger produces a
 * clean diff and is byte-stable regardless of object construction order.
 *
 * `research` is written only where it exists — on amendments (§3.9). A post
 * records its declared hours in `value`, and emitting a redundant `null`
 * beside it would bloat every transaction in the ledger.
 */
function orderedTransaction(t: Transaction) {
  return {
    hash: t.hash,
    type: t.type,
    slug: t.slug,
    title: t.title,
    date: t.date,
    tags: t.tags,
    series: t.series,
    from: t.from,
    to: t.to,
    contentHash: t.contentHash,
    assets: t.assets,
    gasUsed: t.gasUsed,
    value: t.value,
    research: t.research ?? undefined,
    amends: t.amends,
  };
}

function orderedAsset(a: AssetRecord): AssetRecord {
  return {
    tokenId: a.tokenId,
    hash: a.hash,
    file: a.file,
    mime: a.mime,
    bytes: a.bytes,
    mintedIn: a.mintedIn,
  };
}

function orderedBlock(b: Block) {
  return {
    height: b.height,
    period: b.period,
    prevHash: b.prevHash,
    merkleRoot: b.merkleRoot,
    timestamp: b.timestamp,
    txCount: b.txCount,
    gasUsed: b.gasUsed,
    value: b.value,
    difficulty: b.difficulty,
    nonce: b.nonce,
    hash: b.hash,
    transactions: b.transactions.map(orderedTransaction),
  };
}

export function serializeChain(chain: Chain): string {
  const ordered = {
    version: chain.version,
    difficulty: chain.difficulty,
    blocks: chain.blocks.map(orderedBlock),
    assets: chain.assets.map(orderedAsset),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

/**
 * §10 — a corrupt ledger must fail with the offending block and field named.
 * Casting an unvalidated parse to `Chain` instead pushes the failure into
 * `verifyBlock`, where it surfaces as a bare TypeError with no height and no
 * field. The shape checked here is exactly the one the browser verifier
 * checks, so the two cannot drift.
 */
function validateBlocks(path: string, blocks: unknown[]): void {
  for (const [index, block] of blocks.entries()) {
    const problem = blockStructuralProblem(block);
    if (problem !== null) {
      const height =
        typeof block === 'object' && block !== null && 'height' in block
          ? String((block as { height: unknown }).height)
          : '?';
      throw new Error(
        `${path}: block at index ${index} (height ${height}) is malformed — ${problem}; refusing to use a corrupt ledger`,
      );
    }
    // A post read from an older ledger has no `research` key at all; normalize
    // it so the in-memory shape is uniform.
    for (const tx of (block as Block).transactions) {
      if (tx.research === undefined) tx.research = null;
    }
  }
}

/**
 * §10 / §3.2b — `Array.isArray` alone is not a structural check: a hand-edited
 * `assets: [null]` or `assets: [{tokenId: "x"}]` would pass it, seed the mint
 * loop's `known` set with `undefined`, and then lose fields silently when
 * `serializeChain`'s `JSON.stringify` drops them. Name the offending index
 * and field, in the same style as `validateBlocks`.
 *
 * The per-record shape comes from `verify.ts` for the same reason
 * `validateBlocks` takes `blockStructuralProblem` from there: a second copy of
 * "valid record" here would let the Node reader and the browser verifier drift,
 * and the browser is the one holding untrusted input.
 */
function validateAssets(path: string, assets: unknown[]): void {
  for (const [index, rec] of assets.entries()) {
    const problem = assetRecordProblem(rec);
    if (problem !== null) {
      throw new Error(
        `${path}: asset at index ${index} is malformed — ${problem}; refusing to use a corrupt ledger`,
      );
    }
  }
}

export function readLock(path: string, difficulty: number): Chain {
  if (!existsSync(path)) return emptyChain(difficulty);

  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Never silently reset: the lock file is the ledger.
    throw new Error(`${path} is not valid JSON — refusing to overwrite the ledger`, { cause });
  }

  const chain = parsed as Chain;
  if (chain === null || typeof chain !== 'object') {
    throw new Error(`${path} is not a chain object — refusing to use a corrupt ledger`);
  }
  if (chain.version !== 1) {
    throw new Error(`${path} has unsupported chain version ${String(chain.version)}`);
  }
  if (typeof chain.difficulty !== 'number' || !Number.isFinite(chain.difficulty)) {
    throw new Error(
      `${path} has a non-numeric "difficulty" — refusing to use a corrupt ledger`,
    );
  }
  if (!Array.isArray(chain.blocks)) {
    throw new Error(`${path} is missing a valid "blocks" array — refusing to use a corrupt ledger`);
  }
  validateBlocks(path, chain.blocks);
  // An absent key and a wrong-typed key are different faults, and both must
  // refuse rather than default to `[]`: silently extending a lock with no
  // registry would make the mint loop back-fill tokens for already-sealed
  // transactions, so `tokenId` would depend on when the migration ran rather
  // than on first appearance.
  //
  // In practice a *populated* pre-addendum ledger never reaches this line —
  // `validateBlocks` above rejects it first, because its transactions have no
  // `assets` array either. What survives to here is a ledger with no blocks
  // (an empty pre-addendum lock) or one whose `assets` key was deleted by
  // hand. The message still points at the right remedy for both.
  if (chain.assets === undefined) {
    throw new Error(`${path} predates the asset registry (§3.2b) — re-mine the ledger`);
  }
  if (!Array.isArray(chain.assets)) {
    throw new Error(`${path} has a non-array "assets" — refusing to use a corrupt ledger`);
  }
  validateAssets(path, chain.assets);
  return chain;
}

export function writeLock(path: string, chain: Chain): void {
  writeFileSync(path, serializeChain(chain), 'utf8');
}
