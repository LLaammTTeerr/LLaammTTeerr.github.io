import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAIN_CONFIG } from '../../chain.config';
import { normalizeBody } from '../chain/canonical';
import { sha256Hex } from '../chain/hash';
import { readLock } from '../chain/lock';
import { parsePost } from '../chain/post';
import type { AssetRecord, Block, Chain, Hex, Transaction } from '../chain/types';

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

const POSTS_DIR = 'content/posts';

export interface PostContent {
  slug: string;
  /** Normalized body — byte-for-byte what the chain committed. */
  body: string;
  contentHash: Hex;
  tx: Transaction;
}

/**
 * §3.1 — the ledger commits a `contentHash` and stores no body, so nothing
 * structurally prevents the site rendering different text beside a hash that
 * vouches for other text. This re-derives the hash from disk and refuses a
 * mismatch, so a drifted file fails the build instead of shipping a page whose
 * "Verify this transaction" button would contradict what the reader just read.
 *
 * `postsDir` is a parameter only so tests can point at a fixture; production
 * callers use the default.
 */
export async function getPostContent(
  slug: string,
  postsDir: string = POSTS_DIR,
): Promise<PostContent> {
  const tx = getPosts().find((t) => t.slug === slug);
  if (!tx) {
    throw new Error(`no transaction on the chain for post "${slug}"`);
  }

  const path = join(postsDir, `${slug}.md`);
  if (!existsSync(path)) {
    throw new Error(`${path} not found, but "${slug}" is on the chain`);
  }

  const body = normalizeBody(parsePost(path, readFileSync(path, 'utf8')).body);
  const actual = await sha256Hex(body);
  if (actual !== tx.contentHash) {
    throw new Error(
      `${path} does not match the chain: committed ${tx.contentHash.slice(0, 10)}…, ` +
        `on disk ${actual.slice(0, 10)}… — re-run \`npm run chain:build\` to record the edit as an amendment`,
    );
  }

  return { slug, body, contentHash: tx.contentHash, tx };
}

export function getAssets(): AssetRecord[] {
  return [...getChain().assets].sort((a, b) => b.tokenId - a.tokenId);
}

export interface NetworkStats {
  /**
   * The tip's committed height — not the block count. A two-block chain is
   * at height 1, which is what the tip's own header says and what the gutter
   * renders beside it. §14: every displayed field must be a committed one.
   */
  height: number;
  /**
   * Every transaction in the ledger, from the headers' committed `txCount`.
   * Not `getPosts().length`: amendments are transactions too (§3.9), they
   * are committed to `merkleRoot` and counted in `txCount`, and a post count
   * would disagree with the block pages the moment the first one lands.
   */
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
  const tipHeight = chain.blocks.reduce((max, b) => Math.max(max, b.height), 0);
  return {
    height: tipHeight,
    transactions: chain.blocks.reduce((n, b) => n + b.txCount, 0),
    addresses: addresses.size,
    difficulty: chain.difficulty,
    assets: chain.assets.length,
  };
}
