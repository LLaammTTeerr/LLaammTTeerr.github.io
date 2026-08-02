import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

export interface HashWork {
  /** The `0x` marker — not part of the proof, kept unhighlighted. */
  marker: string;
  /** The leading hex zeros a block of this difficulty actually had to find. */
  zeros: string;
  /** Everything after the proven zeros, including a `shortHash`'s `…`. */
  rest: string;
}

/**
 * Splits a hash (or a `shortHash` of one) into the leading zeros that prove
 * `difficulty` was met and everything after, so the UI can highlight the
 * mined prefix instead of showing an undifferentiated wall of hex. A block's
 * own `difficulty` — not the chain's floor — is the correct length: §3.4 lets
 * a block commit to a stricter target than the chain requires, and
 * `verifyBlock` checks the hash against that committed value.
 *
 * Clamped to the string actually available, so a `difficulty` longer than
 * `hash` (or than what a `shortHash` still has visible before its `…`)
 * degrades to "everything after 0x is proven" rather than slicing past the
 * end of the string.
 */
export function splitHashWork(hash: string, difficulty: number): HashWork {
  const n = Math.min(Math.max(difficulty, 0), Math.max(hash.length - 2, 0));
  return { marker: hash.slice(0, 2), zeros: hash.slice(2, 2 + n), rest: hash.slice(2 + n) };
}

/**
 * §3.8 — the author's declared hours of research, formatted for display, or
 * `null` when nothing was declared.
 *
 * `research` is optional and the chain records its absence as `0.0`, which is
 * the correct commitment. Rendering that `0.0` beside genuinely committed
 * figures is not: it reads as "the author declares zero hours of research"
 * when the author declared nothing at all. §3.8 is explicit — the default
 * "displays as `—` rather than a misleading `0`". Callers substitute the em
 * dash; this returns `null` so they cannot print the placeholder by accident.
 */
export function researchHours(value: number): string | null {
  return value > 0 ? value.toFixed(1) : null;
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

export interface PendingPost {
  slug: string;
  title: string;
  date: string;
  tags: string[];
}

export interface PendingBlock {
  /** The open calendar month, YYYY-MM. */
  period: string;
  /** Newest first, matching sealed blocks. */
  posts: PendingPost[];
}

/**
 * §3.6, §9 — the open block. The engine withholds a partial current month from
 * the lock, so a post published this month is on disk and on no block. Without
 * this it would have no page, no URL and no feed entry, which looks exactly
 * like a failed publish.
 *
 * A post is pending when its slug appears in no sealed block. `now` is supplied
 * by the caller, never read here, so builds stay deterministic (§14).
 */
export function getPendingBlock(
  now: string,
  postsDir: string = POSTS_DIR,
): PendingBlock | null {
  const sealed = new Set(getPosts().map((t) => t.slug));

  const posts: PendingPost[] = readdirSync(postsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(postsDir, f))
    .map((path) => parsePost(path, readFileSync(path, 'utf8')))
    .filter((p) => !sealed.has(p.slug))
    .map((p) => ({ slug: p.slug, title: p.title, date: p.date, tags: p.tags }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));

  if (posts.length === 0) return null;
  return { period: now.slice(0, 7), posts };
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
