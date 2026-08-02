import { CHAIN_CONFIG } from '../../chain.config';
import { readLock } from '../chain/lock';
import type { AssetRecord, Block, Chain, Transaction } from '../chain/types';

/**
 * The only module that reads the ledger. Templates import from here and never
 * touch `chain.lock.json` or `src/chain/` directly, so the ledger's shape can
 * change without a sweep through every `.astro` file.
 */

const LOCK_PATH = 'chain.lock.json';

let cached: Chain | null = null;

/**
 * The cache is a singleton for the whole build, and every view shares its
 * nested arrays by reference. Freezing once on read means a template that
 * sorts a `transactions` array in place fails loudly at the mutation instead
 * of silently corrupting every page rendered after it.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Memoized: a static build renders many pages from one ledger read. */
export function getChain(): Chain {
  cached ??= deepFreeze(readLock(LOCK_PATH, CHAIN_CONFIG.difficulty));
  return cached;
}

/** §3.4 — the expected number of attempts to find a nonce at this difficulty. */
export function expectedAttempts(difficulty: number): number {
  return 16 ** difficulty;
}

/** How much work a block actually cost, against what its difficulty predicts. */
export function workRatio(nonce: number, difficulty: number): number {
  return nonce / expectedAttempts(difficulty);
}

/** `0xabc123…def456` — enough to recognise, short enough to sit in a table. */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export interface BlockView extends Block {
  isGenesis: boolean;
  isEmpty: boolean;
  workRatio: number;
  shortHash: string;
}

function toView(block: Block): BlockView {
  return {
    ...block,
    isGenesis: block.height === 0,
    isEmpty: block.transactions.length === 0,
    workRatio: workRatio(block.nonce, block.difficulty),
    shortHash: shortHash(block.hash),
  };
}

/** Newest first — the chain reads backwards into history (§9). */
export function getBlocks(): BlockView[] {
  return [...getChain().blocks].sort((a, b) => b.height - a.height).map(toView);
}

export function getBlock(height: number): BlockView | undefined {
  const block = getChain().blocks.find((b) => b.height === height);
  return block ? toView(block) : undefined;
}

/** Post transactions only. Amendments are ledger entries, not writing (§3.9). */
export function getPosts(): Transaction[] {
  return getChain()
    .blocks.flatMap((b) => b.transactions)
    .filter((t) => t.type === 'post')
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getAssets(): AssetRecord[] {
  return [...getChain().assets].sort((a, b) => b.tokenId - a.tokenId);
}

export interface NetworkStats {
  height: number;
  transactions: number;
  addresses: number;
  difficulty: number;
  assets: number;
}

export function getStats(): NetworkStats {
  const chain = getChain();
  const addresses = new Set<string>();
  for (const block of chain.blocks) {
    for (const tx of block.transactions) {
      addresses.add(tx.from);
      for (const to of tx.to) addresses.add(to);
    }
  }
  return {
    height: chain.blocks.length,
    transactions: getPosts().length,
    addresses: addresses.size,
    difficulty: chain.difficulty,
    assets: chain.assets.length,
  };
}
