import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAIN_CONFIG } from '../../chain.config';
import { normalizeBody } from '../chain/canonical';
import { sha256Hex } from '../chain/hash';
import { readLock } from '../chain/lock';
import { isStale, PENDING_PATH, readPending } from '../chain/pending';
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
 * Clamped to the hex *actually visible*, which for a `shortHash` is the six
 * characters before its `…` and not the whole string. Clamping against the
 * string length instead painted the ellipsis itself as a proven zero at
 * difficulty 7, and a real hex digit from the hash's tail at difficulty 8 —
 * characters the miner never had to find, rendered in the reader's accent as
 * proof of work. §3.4 makes that reachable: the chain's difficulty is
 * configurable and a block may commit to a stricter target than the floor.
 *
 * A difficulty past what is visible degrades to "every visible character is
 * proven" rather than overclaiming.
 */
export function splitHashWork(hash: string, difficulty: number): HashWork {
  const body = hash.slice(2);
  const visible = (body.split('…')[0] ?? '').length;
  const n = Math.min(Math.max(difficulty, 0), visible);
  return { marker: hash.slice(0, 2), zeros: body.slice(0, n), rest: body.slice(n) };
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
  /** Always `true` on a sealed block — lets `AnyBlockView` discriminate. */
  sealed: true;
}

function toView(block: Block): BlockView {
  return {
    ...block,
    isGenesis: block.height === 0,
    isEmpty: block.transactions.length === 0,
    workRatio: workRatio(block.nonce, block.difficulty),
    shortHash: shortHash(block.hash),
    sealed: true,
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
 * §3.9 — the most recent amendment to the transaction `txHash`, or `null` if
 * nothing amends it. This is the chain's latest word on that post's body.
 *
 * Order is the whole substance of this function. The open block is searched
 * first because everything in it is newer than everything sealed. The sealed
 * blocks are then walked in **ascending height**, keeping the last match, so
 * the newest amendment wins: `getChain().blocks` is the lock's own order and
 * `getBlocks()` is the reverse of it, and either one traversed the wrong way
 * silently settles on the *oldest* amendment — accepting the body from two
 * edits ago and refusing the one the author just recorded, with an error
 * message telling them to record it again.
 *
 * Sorted by height rather than trusting array position: `tipHash` above
 * already documents that nothing guarantees the lock is height-ordered, and
 * this must not become the one place that assumes it. (Within a single block,
 * transaction order is the canonical seal order — by `amends` then hash, not
 * by time — so two amendments to one post sealed in the same block cannot be
 * told apart chronologically. Nothing on an amendment records when it was
 * made, so there is no better signal to use; `detectAmendments` emits at most
 * one per post per build, which keeps that shape rare.)
 */
function latestAmendment(txHash: Hex): Transaction | null {
  const amends = (t: Transaction): boolean => t.type === 'amendment' && t.amends === txHash;

  const pending = getPendingBlock();
  if (pending !== null) {
    let newest: Transaction | null = null;
    for (const tx of pending.transactions) if (amends(tx)) newest = tx;
    if (newest !== null) return newest;
  }

  const ascending = [...getChain().blocks].sort((a, b) => a.height - b.height);
  let latest: Transaction | null = null;
  for (const block of ascending) {
    for (const tx of block.transactions) if (amends(tx)) latest = tx;
  }
  return latest;
}

/**
 * §3.1 — the ledger commits a `contentHash` and stores no body, so nothing
 * structurally prevents the site rendering different text beside a hash that
 * vouches for other text. This re-derives the hash from disk and refuses a
 * mismatch, so a drifted file fails the build instead of shipping a page whose
 * "Verify this transaction" button would contradict what the reader just read.
 *
 * Exactly one body is acceptable: the one the chain's latest record names —
 * the newest amendment's `contentHash` (§3.9), or the sealed transaction's
 * when nothing amends it. Comparing against the sealed hash alone was a closed
 * loop: an edit to a sealed post fails this check, the error says to run
 * `chain:build`, `chain:build` records the amendment correctly, and the very
 * same check fails again on the very same hash, forever. The sealed hash is by
 * design the one thing an amendment cannot change.
 *
 * Widening this to "any recorded state" would close the loop too, and would be
 * wrong: the page would render a body the chain's own newest amendment
 * contradicts. Every rejection here has a remedy that works, because
 * `detectAmendments` records any divergence from the latest state — including
 * a revert to an earlier one.
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
  const amendment = latestAmendment(tx.hash);
  // The chain's latest word on this post — what the file must match, and what
  // the error names. Reporting the sealed hash once an amendment supersedes it
  // would send the author chasing text the chain has already moved on from.
  const expected = amendment === null ? tx.contentHash : amendment.contentHash;

  if (actual !== expected) {
    throw new Error(
      `${path} does not match the chain: committed ${expected.slice(0, 10)}…, ` +
        `on disk ${actual.slice(0, 10)}… — re-run \`npm run chain:build\` to record the edit as an amendment`,
    );
  }

  // The recorded hash that matched — the amendment's, or the sealed one — so
  // the page renders a body and a hash that belong to each other and the
  // verify control can only agree.
  return { slug, body, contentHash: expected, tx };
}

export interface PendingBlockView {
  /** Always `false` on the open block — lets `AnyBlockView` discriminate. */
  sealed: false;
  /** The height this block will take once it seals. */
  height: number;
  /** YYYY-MM — the recorded placement (§3.6); does not slide with the clock. */
  period: string;
  /** Recorded transactions, in the order `chain:build` committed them. */
  transactions: Transaction[];
  txCount: number;
  /** Sum over `transactions`. */
  gasUsed: number;
  /** Sum over `transactions`. */
  value: number;
  /** How many transactions a block holds before sealing — the "1/4 giao dịch" fill. */
  maxTxPerBlock: number;
  /** The last calendar day of `period`, YYYY-MM-DD. */
  sealsOn: string;
}

/** Discriminates a sealed block from the still-open one on `sealed`. */
export type AnyBlockView = (BlockView & { sealed: true }) | PendingBlockView;

const ZERO_HASH = '0x' + '00'.repeat(32);

/**
 * The committed tip's hash — the block a recorded open block must still be
 * attached to for `isStale` to accept it. Found by height rather than by
 * array position: nothing here guarantees `chain.blocks` is height-ordered
 * (`getBlocks` itself sorts before use), so the last array element is not
 * reliably the tip.
 */
function tipHash(chain: Chain): Hex {
  let tip: Block | null = null;
  for (const block of chain.blocks) {
    if (tip === null || block.height > tip.height) tip = block;
  }
  return tip ? tip.hash : ZERO_HASH;
}

/**
 * The last calendar day of `period` (`YYYY-MM`), as `YYYY-MM-DD`.
 *
 * Reads no clock — this is pure arithmetic on the recorded string.
 * `period`'s month is 1-based; `Date.UTC(y, m, 0)` asks for day 0 of the
 * *zero-based* month `m`, i.e. the day before that month starts, which is
 * the last day of the recorded (1-based) month `m` itself. UTC's own
 * calendar folds in February and leap years on its own — nothing here
 * special-cases them, and a future edit should not "fix" that in.
 */
function sealsOn(period: string): string {
  const [yearStr = '', monthStr = ''] = period.split('-');
  const last = new Date(Date.UTC(Number(yearStr), Number(monthStr), 0));
  const month = String(last.getUTCMonth() + 1).padStart(2, '0');
  const day = String(last.getUTCDate()).padStart(2, '0');
  return `${last.getUTCFullYear()}-${month}-${day}`;
}

/**
 * §3.6, §9 — the open block, exactly as `chain:build` recorded it.
 *
 * Reads `chain.pending.json` rather than rebuilding the open block from
 * `content/posts/`. Recomputing it here is the defect Task 1 removed from
 * the engine (see the module doc on `PendingLock` in `src/chain/pending.ts`):
 * block membership must be a fact recorded once, or a transaction's
 * placement can slide forward forever and a month can seal empty while
 * holding a post. Takes no arguments and reads no clock (§14) — the recorded
 * file already carries everything needed to render it.
 *
 * A pending file recorded against a tip this chain no longer has belongs to
 * a different history; `null` rather than showing hashes attached to the
 * wrong chain.
 */
export function getPendingBlock(): PendingBlockView | null {
  const pending = readPending(PENDING_PATH);
  if (pending === null) return null;
  if (isStale(pending, tipHash(getChain()))) return null;

  const view: PendingBlockView = {
    sealed: false,
    height: pending.height,
    period: pending.period,
    transactions: pending.transactions,
    txCount: pending.transactions.length,
    gasUsed: pending.transactions.reduce((sum, t) => sum + t.gasUsed, 0),
    value: pending.transactions.reduce((sum, t) => sum + t.value, 0),
    maxTxPerBlock: CHAIN_CONFIG.maxTxPerBlock,
    sealsOn: sealsOn(pending.period),
  };
  return deepFreeze(view);
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
