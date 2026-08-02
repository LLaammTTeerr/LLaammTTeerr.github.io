import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AssetRecord, Block, Chain, Transaction } from './types';
import { blockStructuralProblem } from './verify';

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
 * §3.2b — a single asset record's own shape, independent of whether it
 * agrees with the transactions. Named in the same style as
 * `blockStructuralProblem`/`transactionProblem` in `verify.ts`.
 */
function assetRecordProblem(rec: unknown): string | null {
  if (typeof rec !== 'object' || rec === null) return 'is not an object';
  const r = rec as Record<string, unknown>;
  if (typeof r.tokenId !== 'number' || !Number.isInteger(r.tokenId) || r.tokenId < 1) {
    return 'field "tokenId" is not a positive integer';
  }
  if (typeof r.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.hash)) {
    return 'field "hash" is not a 0x-prefixed 64-hex-digit string';
  }
  if (typeof r.file !== 'string' || r.file === '') return 'field "file" is not a non-empty string';
  if (typeof r.mime !== 'string' || r.mime === '') return 'field "mime" is not a non-empty string';
  if (typeof r.bytes !== 'number' || !Number.isFinite(r.bytes) || r.bytes < 0) {
    return 'field "bytes" is not a non-negative number';
  }
  if (typeof r.mintedIn !== 'number' || !Number.isInteger(r.mintedIn) || r.mintedIn < 0) {
    return 'field "mintedIn" is not a non-negative integer';
  }
  return null;
}

/**
 * §10 / §3.2b — `Array.isArray` alone is not a structural check: a hand-edited
 * `assets: [null]` or `assets: [{tokenId: "x"}]` would pass it, seed the mint
 * loop's `known` set with `undefined`, and then lose fields silently when
 * `serializeChain`'s `JSON.stringify` drops them. Name the offending index
 * and field, in the same style as `validateBlocks`.
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
  // An absent key and a wrong-typed key are different faults: the first is an
  // older ledger that predates this addendum (re-mine it), the second is a
  // hand-edited or truncated one (refuse it). Defaulting the absent case to
  // `[]` would let an older lock be silently extended, and the mint loop
  // would then back-fill tokens for already-sealed transactions — making
  // `tokenId` depend on when the migration ran rather than on first
  // appearance.
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
