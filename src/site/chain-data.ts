import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAIN_CONFIG } from '../../chain.config';
import { referencedAssets } from '../chain/asset';
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
const ASSETS_DIR = 'content/assets';

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
  /**
   * The same post as every other surface sees it (see `ResolvedPost`). This is
   * what the page hands to `TxPanel`; the loose fields above are kept because
   * this function has verified `body` against the chain and they name what it
   * verified.
   */
  post: ResolvedPost;
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
 * §3.9 — a post, resolved to the state the chain currently asserts about it.
 *
 * **This is the only shape a post-centric surface may render.** Five times on
 * this project a page has printed a field off the sealed `post` transaction
 * while the chain's newest word on that post was an amendment: the transaction
 * panel, the address total, the gas figure, the research hours, and finally the
 * transaction rows on `/address/<tag>` and `/about` — where the header total
 * and the rows of one card contradicted each other. Every one of those was a
 * surface holding a `Transaction` and reading a field off it.
 *
 * So the resolution is not something a surface remembers to call: it is a
 * *type*. A component whose prop is a `ResolvedPost` cannot be handed a raw
 * ledger entry — `astro check` (`npm run typecheck`) rejects it. `TxPanel` and
 * `TxRow` both take exactly this and nothing else.
 *
 * The brand is `RESOLVED`, and it is a **module-private `unique symbol`** for a
 * reason found the hard way. It was a `resolved: true` field, which TypeScript's
 * structural typing makes no barrier at all: a page containing
 *
 *     {...tx, resolved: true as const, originalHash: tx.hash, …}
 *
 * — no cast, no `as ResolvedPost` — satisfied the type, typechecked with zero
 * errors, and rendered the superseded state. That is precisely the sixth
 * surface this exists to prevent, reproducing the Critical in full.
 *
 * A `unique symbol` that is never exported cannot be *named* outside this
 * module, so no object literal written anywhere else can carry the property.
 * `resolveWith` below is the only expression in the codebase that produces one,
 * which makes "this value came from the resolution" a fact the compiler checks
 * rather than a shape anyone can imitate.
 *
 * What it still does not stop: spreading a genuine `ResolvedPost` and
 * overwriting a field (`{...post, title: 'lie'}` copies the symbol). Nothing in
 * a structural language stops that, and it is not the accident this guards —
 * it cannot happen by reaching for the wrong variable, only by deciding to.
 *
 * The distinction that survives: a **block** view still renders `RecordedTx`,
 * because a block card describes what that block sealed and an amendment
 * appears in it as its own row. `/blocks` naming the original's title under
 * block #N is a true statement about block #N. An address card's rows are not
 * block-scoped — they are "the posts that sent here", under a header totalling
 * those posts' current hours — so they resolve.
 */
/**
 * The brand key. Deliberately **not exported**: a symbol that cannot be named
 * outside this module cannot be written into an object literal outside it, so
 * `ResolvedPost` is nominal in practice however structural the language is.
 */
const RESOLVED: unique symbol = Symbol('blogchain/resolved-post');

export interface ResolvedPost {
  /** The brand. Only `resolveWith` can produce it — see the note above. */
  readonly [RESOLVED]: true;
  slug: string;
  /**
   * The hash of the record that governs this post now — the newest
   * amendment's, or the original's. This is the hash `/tx/<slug>` prints, and
   * the one that commits to the title, gas and value beside it.
   */
  hash: Hex;
  /**
   * The original `post` transaction's hash — equal to `hash` when nothing
   * amends it. This is what `/blocks` and the sealed block's own page still
   * show, and what an amendment's `Amends` row names, so a reader arriving from
   * either can reconcile the two.
   */
  originalHash: Hex;
  /** The governing record's title; never the superseded one. */
  title: string;
  /**
   * The publication date. Taken from the original: `detectAmendments` copies
   * the original's `date` onto every amendment (§3.9), so this is the same
   * value either way, and reading it from the original keeps the address
   * lists' ordering and `firstSeen`/`lastSeen` independent of later edits.
   */
  date: string;
  from: Hex;
  /**
   * The tags the chain's newest record declares — an amendment's when one
   * supersedes the post. Both are hash-covered (`tags:` is in the `post/1` and
   * the `amendment/1` canonical form alike), so this is what the post *is*
   * filed under now, and it is what `/tx/<slug>` displays.
   *
   * Not the same thing as `publishedTags` below, and the difference is a real
   * dead link this branch shipped: a tag added by an amendment is displayed
   * here but has no address page, because §3.9 keeps the address graph at
   * original publication. Anything **linking** a tag must check that the
   * address exists — see `TxPanel.astro`.
   */
  tags: readonly string[];
  series: string | null;
  /**
   * §3.7/§3.9 — the tag and series slugs this post actually *sent to*: the
   * original transaction's.
   *
   * "An amendment's `to` stays empty even when tags change, so the tag address
   * graph reflects original publication" (§3.9). `getAddresses()` groups on
   * exactly these, so an amendment that renames a tag cannot mint an address no
   * post ever sent to, nor charge its `research` to one.
   */
  publishedTags: readonly string[];
  publishedSeries: string | null;
  /** §3.2b — the governing record's asset hashes. */
  assets: readonly Hex[];
  /** The governing record's `contentHash` — what the body on disk must match. */
  contentHash: Hex;
  /**
   * §3.8 — the word count of the body the chain currently vouches for, or
   * `null` when it could not be re-derived.
   *
   * Never an amendment's recorded `gasUsed`, which §3.9 fixes at 0 so block
   * aggregation cannot re-charge the original's.
   */
  gasUsed: number | null;
  /** §3.8/§3.9 — the newest amendment's `research`, or the original's `value`. */
  value: number;
  /** §3.6 — true while the *governing* record is still in the open block. */
  pending: boolean;
  /** §3.9 — where the amendment sits, or `null` when nothing amends this post. */
  amendedIn: AmendedIn | null;
}

/**
 * The one walk. Every resolved field is decided here and nowhere else, from a
 * post transaction and the amendment (if any) that supersedes it —
 * `getPostContent` passes the amendment it has already found, `resolvePost`
 * finds one. Two entry points, one resolution; there is no third.
 */
function resolveWith(
  tx: RecordedTx,
  amendment: (AmendedIn & { tx: RecordedTx }) | null,
  originalPending: boolean,
): ResolvedPost {
  const governing = amendment === null ? tx : amendment.tx;
  const slug = tx.slug ?? '';
  return {
    [RESOLVED]: true,
    slug,
    hash: governing.hash,
    originalHash: tx.hash,
    title: governing.title ?? tx.title ?? slug,
    date: tx.date,
    from: tx.from,
    tags: governing.tags,
    series: governing.series,
    publishedTags: tx.tags,
    publishedSeries: tx.series,
    assets: governing.assets,
    contentHash: governing.contentHash,
    // An unamended transaction's own `gasUsed` is already the word count of
    // its body: for a sealed one `verifyBlock` checks the block's committed
    // sum, and for a pending one `getPendingBlock` has re-derived it. An
    // amendment's is the accounting zero, so the count has to come from the
    // body its `contentHash` commits to.
    gasUsed: amendment === null ? tx.gasUsed : wordCountOf(slug, governing.contentHash),
    value: valueGiven(tx, amendment),
    // An unamended post is pending exactly when the chain has not sealed it;
    // an amended one is pending exactly when its newest amendment has not
    // sealed, whatever the original did — the record on screen is the
    // amendment (§3.6).
    pending: amendment === null ? originalPending : !amendment.sealed,
    amendedIn: amendment === null ? null : { height: amendment.height, sealed: amendment.sealed },
  };
}

/**
 * Whether a value carries the resolution's own brand.
 *
 * The runtime half of the type, for tests: the compiler enforces the brand at
 * every call site, and this lets a test state the same thing about a value it
 * pulled out of a view. Nothing in `src/` needs it — a `ResolvedPost` is
 * already a `ResolvedPost` there.
 */
export function isResolvedPost(value: unknown): value is ResolvedPost {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[RESOLVED] === true
  );
}

/** §3.9 — one post as the chain currently describes it. */
export function resolvePost(tx: RecordedTx, originalPending: boolean): ResolvedPost {
  return resolveWith(tx, latestAmendment(tx.hash), originalPending);
}

let resolvedCache: ResolvedPost[] | null = null;

/**
 * Every post on the chain — sealed and unsealed — resolved to its current
 * state, in `getPosts()` order followed by the open block's.
 *
 * Memoized for the same reason `getChain()` is: a static build renders many
 * pages from one ledger, and every address page would otherwise re-walk every
 * block for every transaction it lists and re-read `chain.pending.json` each
 * time. Nothing under `src/site/` may mutate the chain, so one resolution per
 * build is the whole truth there is.
 */
export function resolvedPosts(): ResolvedPost[] {
  if (resolvedCache === null) {
    const pending = getPendingPosts();
    resolvedCache = [
      ...getPosts().map((t) => resolvePost(t, false)),
      ...pending.map((t) => resolvePost(t, true)),
    ];
  }
  return resolvedCache;
}

/** One resolved post by slug, or `undefined` when the chain has no such post. */
export function resolvedPost(slug: string): ResolvedPost | undefined {
  return resolvedPosts().find((p) => p.slug === slug);
}

/**
 * §3.2b — the body check `getPostContent` performs, applied to the files that
 * body embeds.
 *
 * These are the same fact: the bytes on disk disagree with what the chain
 * committed. They were not the same failure. A drifted *body* failed the build
 * with the file named and the remedy spelled out; a drifted *image* built
 * cleanly and shipped a post containing `<img src="/assets/so-do.svg">` with
 * nothing at that path, because `src/site/asset-files.ts` correctly refuses to
 * publish bytes the chain does not vouch for. The reader met a broken diagram;
 * the author was told nothing. A silent 404 inside a published post is the
 * worse failure of the two, and it is recoverable in one command.
 *
 * The comparison is against `governing.assets` — the transaction that commits
 * to the body being rendered, which is the newest amendment when there is one.
 * Only a *current* transaction counts: a superseded token's bytes are gone
 * from disk by definition, and a file no post references is not on the chain
 * at all (§3.2b). Neither is drift, and neither may fail a build.
 *
 * `referencedAssets` is the same function `chain:build` reads references with,
 * over a body already proved to hash to what `governing` commits to — so the
 * filenames here are exactly the ones the engine hashed, and the only thing
 * that can have changed is the bytes behind them.
 *
 * A file that is *gone* is reported as gone. The remedy differs: no rerun of
 * `chain:build` can record bytes that no longer exist, so the author must put
 * the file back or stop referencing it.
 */
async function refuseDriftedAssets(
  slug: string,
  body: string,
  governing: RecordedTx,
  assetsDir: string,
  records: string,
): Promise<void> {
  const refs = referencedAssets(body);
  if (refs.length === 0) return;

  // A multiset, consumed as files claim their hashes: two referenced files may
  // legitimately hold identical bytes, and `assets` records the hash twice
  // (`toTransaction` sorts, it does not dedupe). A `Set` here would report the
  // second file as drifted the moment the first claimed the value.
  const unclaimed = [...governing.assets];
  const drifted: Array<{ path: string; hash: Hex }> = [];

  for (const file of refs) {
    const path = join(assetsDir, file);
    if (!existsSync(path)) {
      throw new Error(
        `${path} not found, but "${slug}" references /assets/${file} — restore the file, ` +
          'or remove the reference from the post and re-run `npm run chain:build`',
      );
    }
    // Raw bytes, no normalization — an asset is binary, not text (§3.2b).
    const hash = await sha256Hex(new Uint8Array(readFileSync(path)));
    const at = unclaimed.indexOf(hash);
    if (at === -1) drifted.push({ path, hash });
    else unclaimed.splice(at, 1);
  }

  const first = drifted[0];
  if (first === undefined) return;

  // With the body verified, one referenced file yields one committed hash, so
  // a single drifted file leaves exactly one hash unaccounted for and the two
  // can be named as a pair — the shape the body message uses. When several
  // files changed at once the pairing is genuinely unrecoverable: `assets` is
  // sorted (§3.2b, so declaration order cannot move the transaction hash) and
  // the chain records no filename beside a hash that any hash covers. Saying
  // which committed value *this* file used to be would be a guess, so it says
  // what it does know instead.
  const committed =
    unclaimed.length === 1
      ? `committed ${unclaimed[0]!.slice(0, 10)}…, `
      : '';
  const among =
    unclaimed.length === 1
      ? ''
      : `, which is none of the ${governing.assets.length} asset hashes "${slug}" commits to`;

  throw new Error(
    `${first.path} does not match the chain: ${committed}` +
      `on disk ${first.hash.slice(0, 10)}…${among} — ` +
      `re-run \`npm run chain:build\` to ${records}`,
  );
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
 * `postsDir` and `assetsDir` are parameters only so tests can point at a
 * fixture; production callers use the defaults.
 */
export async function getPostContent(
  slug: string,
  postsDir: string = POSTS_DIR,
  assetsDir: string = ASSETS_DIR,
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

  // The remedy is the same command either way, but not the same event: an
  // edit to a *sealed* post is recorded as an amendment (§3.9), while an
  // edit to one still in the open block simply re-hashes its transaction —
  // nothing is committed yet for an amendment to be evidence against
  // (§3.6). Naming an amendment there would tell the author to expect a
  // ledger entry that will not appear.
  //
  // Hoisted out of the body-drift branch because the asset check below tells
  // the author to run the same command about the same post, and the two
  // messages must not disagree about what it will record.
  const records = sealed === undefined ? 'record the edit' : 'record the edit as an amendment';

  if (actual !== expected) {
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

  // §3.2b — and the same for the files that body embeds. After the body check,
  // deliberately: `referencedAssets` reads the body, so it must be a body the
  // chain has already vouched for, and an author who has edited both wants to
  // be told about the text first.
  await refuseDriftedAssets(slug, body, governing, assetsDir, records);

  return {
    slug,
    body,
    contentHash: expected,
    tx,
    governing,
    // The same resolution every other post-centric surface renders, built from
    // the amendment this function has already walked for — so `/tx/<slug>`,
    // `/address/<tag>` and `/about` cannot state different titles, hashes,
    // word counts or hours for one post. `sealed === undefined` is exactly
    // "the original is in the open block".
    post: resolveWith(tx, amendment, sealed === undefined),
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
  return wordCountOf(tx.slug, tx.contentHash);
}

/**
 * The word count of `content/posts/<slug>.md`, but only when that file hashes
 * to `contentHash` — otherwise `null`.
 *
 * The rule `derivedGas` was written for, extracted so the amendment case can
 * use it too: after an amendment the count has to come from the body the
 * *amendment's* `contentHash` commits to, and the amendment carries no slug of
 * its own. Never falls back to a recorded number; a figure that could not be
 * re-derived is not a figure this site may print.
 */
function wordCountOf(slug: string, contentHash: Hex): number | null {
  if (slug === '') return null;
  const path = join(POSTS_DIR, `${slug}.md`);
  if (!existsSync(path)) return null;
  const body = normalizeBody(parsePost(path, readFileSync(path, 'utf8')).body);
  return sha256HexSync(body) === contentHash ? wordCount(body) : null;
}

/**
 * §3.2b — every filename the bodies the chain *currently* vouches for
 * reference, across every post on the chain.
 *
 * This is the set of `/assets/<file>` urls the site actually emits an
 * `<img src>` for, so it is the only set of paths `dist` may serve
 * (`src/site/asset-files.ts`). Read from each post's *governing* body: a file
 * an amendment stopped referencing is no longer named by anything on the
 * chain, and a file the chain never named is "not on the chain at all; it is
 * just a file" (§3.2b).
 *
 * A body that does not hash to what the chain committed contributes nothing.
 * That state fails the build at `getPostContent` with its own message; it must
 * not be the thing that decides what gets published.
 */
export function referencedAssetNames(): Set<string> {
  const names = new Set<string>();
  for (const post of resolvedPosts()) {
    const path = join(POSTS_DIR, `${post.slug}.md`);
    if (!existsSync(path)) continue;
    const body = normalizeBody(parsePost(path, readFileSync(path, 'utf8')).body);
    if (sha256HexSync(body) !== post.contentHash) continue;
    for (const file of referencedAssets(body)) names.add(file);
  }
  return names;
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
  return metaLine(tx.gasUsed, tx.value);
}

/**
 * §3.8/§3.9 — the same line for a **post-centric** row, from the state the
 * chain currently asserts (`ResolvedPost`) rather than from a ledger entry.
 *
 * Separate from `txMetaLine` on purpose, and the separation is the fix for
 * defect shape 1. `txMetaLine` describes a transaction *inside a block*, where
 * the sealed figures are the truth about that block. A row on `/address/<tag>`
 * or `/about` describes a **post**, under a header that totals those posts'
 * current hours — so it must resolve, or the card contradicts itself. Handing
 * one function both jobs is what let `/address/[name].astro` print `4.0` under
 * a `15.0` header for a post the chain says is 12.5.
 */
export function postMetaLine(post: ResolvedPost): string {
  return metaLine(post.gasUsed, post.value);
}

function metaLine(gasUsed: number | null, value: number): string {
  const hours = researchHours(value);
  return `${gasUsed === null ? '—' : `${gasUsed} từ`} · ${hours ? `${hours} giờ` : '—'}`;
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
  difficulty: number;
  assets: number;
}

/**
 * The homepage tiles.
 *
 * There is no `addresses` field here, and its absence is the fix for a page
 * disagreeing with a page. The tile used to count `from` + `tags` + `series`
 * over the **sealed** blocks with its own walk, while `/address` — headed
 * *Addresses* too, one click away — listed what `src/site/addresses.ts`
 * derives, which includes the open block. In a driven sandbox they read 5 and
 * 4. Both numbers now come from `addressIndex()` in `src/site/addresses.ts`,
 * which is also what builds the rows on the page, so the tile cannot claim a
 * number the list contradicts: there is one derivation, not two that happen to
 * match.
 */
export function getStats(): NetworkStats {
  const chain = getChain();
  const tipHeight = chain.blocks.reduce((max, b) => Math.max(max, b.height), 0);
  return {
    height: tipHeight,
    transactions: chain.blocks.reduce((n, b) => n + b.txCount, 0),
    difficulty: chain.difficulty,
    assets: chain.assets.length,
  };
}
