import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Block, Chain, Transaction } from './types';
import { blockStructuralProblem } from './verify';

export function emptyChain(difficulty: number): Chain {
  return { version: 1, difficulty, blocks: [] };
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
    gasUsed: t.gasUsed,
    value: t.value,
    research: t.research ?? undefined,
    amends: t.amends,
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
  return chain;
}

export function writeLock(path: string, chain: Chain): void {
  writeFileSync(path, serializeChain(chain), 'utf8');
}
