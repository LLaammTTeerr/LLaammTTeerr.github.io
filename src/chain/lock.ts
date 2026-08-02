import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Block, Chain, Transaction } from './types';

export function EMPTY_CHAIN(difficulty: number): Chain {
  return { version: 1, difficulty, blocks: [] };
}

/**
 * Serialize with an explicit key order so the committed ledger produces a
 * clean diff and is byte-stable regardless of object construction order.
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

export function readLock(path: string, difficulty: number): Chain {
  if (!existsSync(path)) return EMPTY_CHAIN(difficulty);

  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Never silently reset: the lock file is the ledger.
    throw new Error(`${path} is not valid JSON — refusing to overwrite the ledger`, { cause });
  }

  const chain = parsed as Chain;
  if (chain.version !== 1) {
    throw new Error(`${path} has unsupported chain version ${String(chain.version)}`);
  }
  return chain;
}

export function writeLock(path: string, chain: Chain): void {
  writeFileSync(path, serializeChain(chain), 'utf8');
}
