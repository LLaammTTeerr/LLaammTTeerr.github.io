import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAIN_CONFIG } from '../../chain.config';
import { normalizeBody, wordCount } from '../chain/canonical';
import { sha256Hex } from '../chain/hash';
import { sha256HexSync } from '../chain/hash-node';
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

/**
 * A transaction as a view may describe it.
 *
 * Identical to `Transaction` except that `gasUsed` may be `null`. §3.8 makes
 * gas a **derived** field — the word count of the normalized body — and it is
 * the one displayed field no transaction hash covers: it appears in neither
 * the `post/1` nor the `amendment/1` canonical form. On a sealed transaction
 * that is harmless, because `verifyBlock` checks each block's committed
 * `gasUsed` against the sum over its transactions. The open block has no mined
 * header and so no committed sum, which left a hand-edited
 * `chain.pending.json` free to claim any word count it liked and have the
 * block cards print it.
 *
 * So the open block's figures are re-derived from the body their own
 * `contentHash` commits to, and `null` says "not re-derivable" — never the
 * recorded number, the same rule by which the open block shows no hash it has
 * not mined.
 */
export type RecordedTx = Omit<Transaction, 'gasUsed'> & { gasUsed: number | null };

/**
 * §3.6 — post transactions in the still-open block: published, hashed, in the
 * chain, and not yet sealed.
 *
 * Separate from `getPosts()` rather than folded into it. Every existing caller
 * of `getPosts()` reads fields only a sealed transaction has a truthful answer
 * for — the block it was sealed in, the `Sealed` stamp, the confirmed hash —
 * and silently widening it would make each of those assert something about a
 * transaction the chain has not committed to yet. A route that wants both asks
 * for both, and says which is which.
 *
 * Amendments are filtered out for the same reason `getPosts()` filters them:
 * they are ledger entries about a post, not a post, and they carry no slug to
 * build a page from (§3.9).
 */
export function getPendingPosts(): RecordedTx[] {
  const pending = getPendingBlock();
  if (pending === null) return [];
  return pending.transactions.filter((t) => t.type === 'post');
}

const POSTS_DIR = 'content/posts';

/** §3.9 — where the amendment that records a post's current state now sits. */
export interface AmendedIn {
  /**
   * The block holding the amendment. A committed height while `sealed`; the
   * open block's predicted height otherwise, which is why the notice built
   * from this must not name a block number until it is sealed.
   */
  height: number;
  /** False while the amendment is still in the open block (§3.6). */
  sealed: boolean;
}

export interface PostContent {
  slug: string;
  /** Normalized body — byte-for-byte what the chain committed. */
  body: string;
  contentHash: Hex;
  /**
   * The chain's original `post` transaction for this slug. Once an amendment
   * supersedes it this is history: it names when the post entered the chain
   * and what it said then, and it describes **none** of what is rendered.
   */
  tx: RecordedTx;
  /**
   * The transaction whose hash commits to `body` — the newest amendment, or
   * `tx` when nothing amends it.
   *
   * Every field a page states about the text beside it must come from here.
   * Rendering `tx`'s hash, title, tags, gas and value over an amended body
   * printed a hash that does not commit to the words under it, which is the
   * one falsehood this project cannot ship (§3.2, §7).
   */
  governing: RecordedTx;
  /** True while `governing` is in the open block — it is not `Sealed` (§3.6). */
  pending: boolean;
  /**
   * §3.8 — the word count of `body`, recomputed rather than read off a
   * transaction. `gasUsed` is a derived field, and an amendment's is 0 by
   * design (§3.9) so block totals cannot double-count it; the original's is
   * the count of text that is no longer on screen. A count taken from a body
   * whose hash `governing` commits to is verifiable, which neither of those
   * is.
   */
  gasUsed: number;
  /**
   * §3.8/§3.9 — the declared research hours the chain's newest record carries:
   * an amendment's `research`, or a post's `value`. An amendment's own `value`
   * is 0 by design and must never be displayed as the figure.
   */
  value: number;
  /** §3.9 — null when nothing amends this post. */
  amendedIn: AmendedIn | null;
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
function latestAmendment(txHash: Hex): (AmendedIn & { tx: RecordedTx }) | null {
  const amends = (t: RecordedTx): boolean => t.type === 'amendment' && t.amends === txHash;

  const pending = getPendingBlock();
  if (pending !== null) {
    let newest: RecordedTx | null = null;
    for (const tx of pending.transactions) if (amends(tx)) newest = tx;
    if (newest !== null) return { tx: newest, height: pending.height, sealed: false };
  }

  const ascending = [...getChain().blocks].sort((a, b) => a.height - b.height);
  let latest: (AmendedIn & { tx: RecordedTx }) | null = null;
  for (const block of ascending) {
    for (const tx of block.transactions) {
      if (amends(tx)) latest = { tx, height: block.height, sealed: true };
    }
  }
  return latest;
}

/**
 * §3.8/§3.9 — the declared research hours of a post, given the amendment (if
 * any) that supersedes it.
 *
 * The rule §3.9 states outright: "a reader wanting a post's current effort
 * figure reads `research` from the newest amendment, falling back to `value` on
 * the original transaction". An amendment's own `value` is fixed at 0 so block
 * aggregation cannot re-charge hours the original's block already counted, so
 * reading `value` off the newest record yields the accounting zero rather than
 * the figure, and reading it off the *original* yields a number the chain has
 * moved on from.
 *
 * Split out with the resolved amendment as a parameter so `getPostContent`,
 * which has already walked for it, and `currentValue`, which has not, state the
 * rule once between them.
 */
function valueGiven(tx: RecordedTx, amendment: { tx: RecordedTx } | null): number {
  return amendment === null ? tx.value : (amendment.tx.research ?? 0);
}

/**
 * §3.8/§3.9 — the hours the chain's newest record for `tx` declares.
 *
 * The same resolution `getPostContent` performs, over the same
 * `latestAmendment`, so a total built from this cannot drift from the figure
 * the post's own page prints beside its text. Unlike `getPostContent` this
 * touches no file on disk and throws nothing: it answers from the ledger and
 * the recorded open block alone, which is all an aggregate needs.
 */
export function currentValue(tx: RecordedTx): number {
  return valueGiven(tx, latestAmendment(tx.hash));
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
  // Sealed first, then the open block. A slug cannot be in both: `buildChain`
  // drops a live post whose slug is already sealed, representing later edits
  // to it as amendments (§3.9).
  //
  // A pending post gets exactly the same treatment from here on, deliberately.
  // It is not in `chain.lock.json`, but it *is* recorded in
  // `chain.pending.json` with a `contentHash` derived from the same file, so
  // there is a committed value to check the body against — and skipping the
  // check for it would leave the one window in which every freshly published
  // post lives unguarded, which is precisely where an unrecorded edit is most
  // likely. What sealing adds is immutability, not identity (§3.6).
  const sealed = getPosts().find((t) => t.slug === slug);
  const tx = sealed ?? getPendingPosts().find((t) => t.slug === slug);
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
  const expected = amendment === null ? tx.contentHash : amendment.tx.contentHash;

  if (actual !== expected) {
    // The remedy is the same command either way, but not the same event: an
    // edit to a *sealed* post is recorded as an amendment (§3.9), while an
    // edit to one still in the open block simply re-hashes its transaction —
    // nothing is committed yet for an amendment to be evidence against
    // (§3.6). Naming an amendment there would tell the author to expect a
    // ledger entry that will not appear.
    const records = sealed === undefined ? 'record the edit' : 'record the edit as an amendment';
    // A rejected open block is the one cause this advice does not address, and
    // it is invisible from here otherwise: `readPending` collapses "no file"
    // and "a file this reader will not accept" into the same `null`, so the
    // amendment vouching for this body simply stops existing and the error
    // reads as ordinary drift. Say which it is, or the author re-runs
    // `chain:build` against a file that was never the problem.
    const rejected = existsSync(PENDING_PATH) && getPendingBlock() === null;
    const note = rejected
      ? ` — note: ${PENDING_PATH} exists but was not accepted (a transaction hash that does not` +
        ' recompute, or a record written against a different tip), so any amendment it held' +
        ' vouches for nothing here'
      : '';
    throw new Error(
      `${path} does not match the chain: committed ${expected.slice(0, 10)}…, ` +
        `on disk ${actual.slice(0, 10)}… — re-run \`npm run chain:build\` to ${records}${note}`,
    );
  }

  // The transaction that matched — the amendment's, or the original — so the
  // page renders a body and a hash that belong to each other and the verify
  // control can only agree. Resolved here and nowhere else: a component that
  // repeated this walk would be free to disagree with the hash the body was
  // just accepted against.
  const governing = amendment === null ? tx : amendment.tx;
  return {
    slug,
    body,
    contentHash: expected,
    tx,
    governing,
    // An unamended post is pending exactly when the chain has not sealed it;
    // an amended one is pending exactly when its newest amendment has not
    // sealed, whatever the original did. The stamp describes the transaction
    // on screen, and after an amendment that is the amendment (§3.6).
    pending: amendment === null ? sealed === undefined : !amendment.sealed,
    // §3.8 — derived from the body, not read off a transaction. `body` has
    // already been proved to hash to what `governing` commits to, so this
    // count is as verifiable as the hash beside it.
    gasUsed: wordCount(body),
    // §3.9 — an amendment's declared hours live in `research`; its `value` is
    // 0 so block aggregation cannot re-charge them. Shared with `currentValue`,
    // which the address pages total, so the figure under a post's text and the
    // figure its tag's address page adds up cannot disagree.
    value: valueGiven(tx, amendment),
    amendedIn: amendment === null ? null : { height: amendment.height, sealed: amendment.sealed },
  };
}

export interface PendingBlockView {
  /** Always `false` on the open block — lets `AnyBlockView` discriminate. */
  sealed: false;
  /** The height this block will take once it seals. */
  height: number;
  /** YYYY-MM — the recorded placement (§3.6); does not slide with the clock. */
  period: string;
  /**
   * Recorded transactions, in the order `chain:build` committed them, with
   * each `gasUsed` re-derived from the body its own `contentHash` commits to
   * (see `RecordedTx`).
   */
  transactions: RecordedTx[];
  txCount: number;
  /** Sum over `transactions`; `null` if any one of them is not re-derivable. */
  gasUsed: number | null;
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
 * §3.8 — the word count of the body a recorded transaction commits to,
 * recomputed from disk, or `null` when no body on disk hashes to that value.
 *
 * This is the open block's analogue of the check the mined header gives a
 * sealed block. A transaction hash covers neither `post/1` nor `amendment/1`
 * gas — the field is derived, so it was never put in the canonical form, and
 * adding it now would change the format and invalidate every hash already in
 * `chain.lock.json`. It does not need to be there: the *body* is committed, as
 * `contentHash`, so a count taken from a body that hashes to the committed
 * value is exactly as verifiable as the hash beside it.
 *
 * An amendment is 0 by definition (§3.9) rather than by derivation, and
 * `readPending` refuses a recorded amendment that says otherwise, so it is
 * returned as the constant it is.
 *
 * Never falls back to the recorded figure. A number that could not be
 * re-derived is not a number this site may print.
 */
function derivedGas(tx: Transaction): number | null {
  if (tx.type === 'amendment') return 0;
  if (tx.slug === null) return null;
  const path = join(POSTS_DIR, `${tx.slug}.md`);
  if (!existsSync(path)) return null;
  const body = normalizeBody(parsePost(path, readFileSync(path, 'utf8')).body);
  return sha256HexSync(body) === tx.contentHash ? wordCount(body) : null;
}

/**
 * §3.8/§3.9 — the gas-and-value line under a transaction in a block's list.
 *
 * Three cases, and the distinction is load-bearing:
 *
 *  - a post: its word count and its declared hours;
 *  - an amendment: neither figure, and a note saying where they went. §3.9
 *    fixes an amendment's `gasUsed` and `value` at 0 so block aggregation
 *    cannot re-charge what the original's block already counted — but printed
 *    bare, that 0 reads as "this post has no words", and the post page shows
 *    the real figures derived from the body the amendment commits to. Two
 *    pages showing different numbers for one transaction, with nothing saying
 *    why, invites the reader to conclude one of them is lying. The aggregation
 *    itself is untouched; only what the row says about it changes;
 *  - a figure that could not be re-derived: an em dash, never the recorded
 *    number, on the same rule as the open block's unmined hash.
 */
export function txMetaLine(tx: RecordedTx): string {
  if (tx.type === 'amendment') return 'đính chính · gas và giờ đã tính ở bản gốc';
  const hours = researchHours(tx.value);
  return `${tx.gasUsed === null ? '—' : `${tx.gasUsed} từ`} · ${hours ? `${hours} giờ` : '—'}`;
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
 * file, plus the bodies it commits to, carry everything needed to render it.
 *
 * The one thing it does NOT take from the file is `gasUsed`: that is derived
 * (§3.8) and covered by no transaction hash, so it is recomputed here from the
 * body each `contentHash` commits to. See `RecordedTx` and `derivedGas`.
 *
 * A pending file recorded against a tip this chain no longer has belongs to
 * a different history; `null` rather than showing hashes attached to the
 * wrong chain.
 */
export function getPendingBlock(): PendingBlockView | null {
  const pending = readPending(PENDING_PATH);
  if (pending === null) return null;
  if (isStale(pending, tipHash(getChain()))) return null;

  const transactions = pending.transactions.map(
    (t): RecordedTx => ({ ...t, gasUsed: derivedGas(t) }),
  );

  const view: PendingBlockView = {
    sealed: false,
    height: pending.height,
    period: pending.period,
    transactions,
    txCount: transactions.length,
    // One unverifiable figure makes the total unverifiable. Summing the rest
    // would report a smaller number as though it were the block's gas.
    gasUsed: transactions.some((t) => t.gasUsed === null)
      ? null
      : transactions.reduce((sum, t) => sum + (t.gasUsed ?? 0), 0),
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

  // §14 — every displayed field must be a committed one, and the homepage
  // renders this under an "Addresses" tile.
  //
  // Counted from `from`, `tags` and `series`, and deliberately **not** from
  // `to`. `to` appears in neither the `post/1` nor the `amendment/1` canonical
  // form (src/chain/canonical.ts): it is derived from the tags, so it was never
  // put in the form the transaction hash covers. Nothing therefore checks it —
  // `verifyChain` reports a lock whose `to` has been rewritten as perfectly
  // clean — and this tile was reading it, so a tampered ledger could have named
  // any number of addresses that do not exist and none of the ones that do.
  // The three fields used instead are all in the canonical form, so this count
  // is as verifiable as the hashes beside it.
  //
  // It is also the same derivation `src/site/addresses.ts` uses to decide which
  // address pages exist, so the tile cannot claim a number the pages contradict.
  //
  // Slugs rather than derived hex: §3.7 puts tags and series in a single `tag`
  // domain, so distinct slugs are distinct addresses and a tag and a series
  // that share a slug are one address (intended — see the note in
  // `src/site/addresses.ts`). Deriving the digests would make this async and
  // change no count. The two sets never overlap: an identity is `0x` + 40 hex,
  // a topic is a slug.
  const identities = new Set<string>();
  const topics = new Set<string>();
  for (const block of chain.blocks) {
    for (const tx of block.transactions) {
      identities.add(tx.from);
      // §3.9 — "an amendment's `to` stays empty even when tags change, so the
      // tag address graph reflects original publication". An amendment that
      // renamed a tag must not mint an address no post ever sent to.
      if (tx.type !== 'post') continue;
      for (const tag of tx.tags) topics.add(tag);
      if (tx.series !== null) topics.add(tx.series);
    }
  }

  const tipHeight = chain.blocks.reduce((max, b) => Math.max(max, b.height), 0);
  return {
    height: tipHeight,
    transactions: chain.blocks.reduce((n, b) => n + b.txCount, 0),
    addresses: identities.size + topics.size,
    difficulty: chain.difficulty,
    assets: chain.assets.length,
  };
}
