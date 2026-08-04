import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChainConfig } from '../../chain.config';
import { identityAddress } from './address';
import { hashAssetFile, referencedAssets, type AssetFile } from './asset';
import { canonicalAmendmentTx, canonicalPostTx } from './canonical';
import { sha256Hex } from './hash';
import { readLock, writeLock } from './lock';
import { merkleRootHex } from './merkle';
import { mine } from './mine';
import {
  isStale,
  PENDING_PATH,
  readPending,
  writePending,
  type PendingLock,
} from './pending';
import { monthOf } from './period';
import { parsePost, toTransaction } from './post';
import { blockTimestamp, planChain, txIdentity } from './seal';
import type { Block, Chain, Hex, Transaction } from './types';
import { verifyChain, type ChainVerification } from './verify';

const ZERO_HASH = '0x' + '00'.repeat(32);

/**
 * Name what actually failed. A registry-only fault leaves every block `ok`, so
 * reporting the failing block list alone produced an empty message with no
 * cause — the operator saw "failed verification at block  —" and nothing else.
 */
function failureDetail(result: ChainVerification): string {
  const parts: string[] = [];
  const bad = result.blocks.filter((b) => !b.ok).map((b) => `#${b.height}`);
  if (bad.length > 0) parts.push(`block ${bad.join(', ')}`);
  if (result.registry !== undefined) parts.push(`asset registry: ${result.registry}`);
  // A document-level fault leaves the block list empty too, for the same
  // reason and with the same consequence if it goes unnamed.
  if (result.chain !== undefined) parts.push(result.chain);
  return parts.length > 0 ? parts.join('; ') : 'an unreported fault';
}

export interface BuildOptions {
  postsDir: string;
  assetsDir: string;
  lockPath: string;
  /** Injected clock, YYYY-MM-DD. */
  now: string;
  config: ChainConfig;
}

export interface BuildResult {
  chain: Chain;
  /** Blocks sealed by this build. */
  minted: number;
  /**
   * Amendment transactions **sealed** by this build.
   *
   * An amendment that lands in the still-open block is not counted here — it
   * has not entered sealed history yet. Look in `pending` for those.
   */
  amendments: number;
  /**
   * The open block after this build: placed, recorded, but not yet sealed.
   * Null when nothing is waiting. This is the same content written to
   * `chain.pending.json`.
   */
  pending: PendingLock | null;
  /** §3.6 — periods this build sealed as empty blocks, in seal order. */
  mintedEmpty: string[];
  /**
   * Transactions this build had to place with no record covering them, *and*
   * whose placement this build could actually have denied — i.e. it sealed at
   * least one empty block for a month at or after where they might have been
   * waiting, and the tip's month is already over.
   *
   * Non-empty means the guarantee may not have held for these transactions: if
   * `chain.pending.json` was deleted, `git clean`ed, or lost in a merge, their
   * placement was reassigned from the clock in this very build, and a month
   * that really held them has just sealed as a permanent, mined empty block
   * denying it. The build cannot tell that apart from a genuinely new
   * transaction, so it reports rather than fails.
   *
   * Both conditions are load-bearing, and dropping either makes the warning
   * fire on ordinary publishing. Without the empty-block condition it fires on
   * the first post of every new month — the single most ordinary thing an
   * author does — because a brand-new transaction is by definition unrecorded
   * and the tip is by then a month behind. Nothing is denied there: no month
   * sealed empty, so no month that held the transaction was reported silent.
   * A data-loss warning that cries wolf trains the reader to ignore it, which
   * is the exact failure it exists to prevent.
   */
  unrecorded: Transaction[];
}

async function readPostTransactions(
  postsDir: string,
  assetsDir: string,
  from: Hex,
): Promise<{ txs: Transaction[]; files: Map<Hex, AssetFile> }> {
  const names = readdirSync(postsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const txs: Transaction[] = [];
  const files = new Map<Hex, AssetFile>();

  for (const name of names) {
    const path = join(postsDir, name);
    const post = parsePost(path, readFileSync(path, 'utf8'));
    const resolved: AssetFile[] = [];
    for (const file of referencedAssets(post.body)) {
      const asset = await hashAssetFile(assetsDir, file, path);
      resolved.push(asset);
      files.set(asset.hash, asset);
    }
    txs.push(await toTransaction(post, from, resolved));
  }

  return { txs, files };
}

/**
 * The state a transaction asserts a post is in, as a `post/1` hash.
 *
 * For a post that is its own hash. For an amendment it is the hash the post
 * *would* have if it were published today with the amended metadata and body —
 * which is exactly what the next build compares the live post against. This is
 * what lets a recorded amendment be recognized as already covering an edit,
 * with no extra bookkeeping field in the ledger.
 */
function stateHash(tx: Transaction): Promise<Hex> | null {
  if (tx.type === 'post') return Promise.resolve(tx.hash);
  if (tx.title === null || tx.research === null) return null;
  return sha256Hex(
    canonicalPostTx({
      title: tx.title,
      date: tx.date,
      tags: tx.tags,
      series: tx.series,
      research: tx.research,
      from: tx.from,
      contentHash: tx.contentHash,
      assets: tx.assets,
    }),
  );
}

/**
 * §3.9 — a sealed post whose transaction hash no longer matches the state the
 * chain last recorded it in produces an amendment transaction rather than a
 * rewrite. A post already recorded in its current state emits nothing, so an
 * unchanged build adds no transaction.
 *
 * Detection is on the full `post/1` hash, not the content hash: a retitle, a tag
 * change or a corrected research figure leaves the body untouched, and
 * comparing content hashes would let every such edit vanish — no amendment, no
 * transaction, no warning, and stale metadata on the chain forever.
 *
 * The comparison is against the post's **latest** recorded state and nothing
 * else. Comparing against the set of every state ever recorded — which is what
 * this did — meant reverting a post to an earlier amended state looked "already
 * covered": no amendment was emitted, while the chain's newest amendment went
 * on asserting a different body. Since the site renders the latest recorded
 * state, that left the file on disk permanently unrenderable, failing the build
 * with the advice to run this very command, which recorded nothing, forever.
 * Reverting a change is an ordinary thing to do, so it must be recordable.
 *
 * A revert therefore emits an amendment identical in every canonical field to
 * the one that first recorded that state, and so identical in hash — the same
 * state honestly produces the same transaction id. Nothing on the chain
 * requires transaction hashes to be unique across blocks (the Merkle root
 * commits each block's own list, and `verifyChain` recomputes each transaction
 * from its own fields), and the alternative — a sequence number in the
 * canonical form — would make the hash depend on history rather than on the
 * state it attests.
 */
async function detectAmendments(
  sealed: Transaction[],
  current: Transaction[],
  from: Hex,
  postsDir: string,
): Promise<Transaction[]> {
  const currentBySlug = new Map(current.map((t) => [t.slug, t]));

  // The state each post was last recorded in, keyed by the original's hash.
  // `sealed` arrives in ascending block order and later writes overwrite
  // earlier ones, so what survives is the newest amendment to each post —
  // ordering this map is load-bearing, not incidental.
  const recordedState = new Map<Hex, Hex>();
  for (const tx of sealed) {
    if (tx.type !== 'amendment' || tx.amends === null) continue;
    const state = await stateHash(tx);
    if (state !== null) recordedState.set(tx.amends, state);
  }

  const out: Transaction[] = [];
  for (const original of sealed) {
    if (original.type === 'amendment') continue;
    const live = currentBySlug.get(original.slug);
    if (!live) continue;

    // Same filename, different date: a new post reusing a slug, not an edit of
    // the old one. Recording it as an amendment would silently attach it to an
    // unrelated transaction, so refuse and name both dates.
    if (live.date !== original.date) {
      throw new Error(
        `${join(postsDir, `${original.slug}.md`)}: slug "${original.slug}" is already on the chain ` +
          `dated ${original.date}, but this file is dated ${live.date} — a reused filename is a ` +
          `different post, not an edit; give it a new filename`,
      );
    }

    // Nothing to record only when the file already *is* the chain's latest
    // word on this post: its newest amendment, or the original itself when
    // none amends it.
    if (live.hash === (recordedState.get(original.hash) ?? original.hash)) continue;

    const hash = await sha256Hex(
      canonicalAmendmentTx({
        amends: original.hash,
        date: original.date,
        title: live.title!,
        tags: live.tags,
        series: live.series,
        research: live.value,
        from,
        contentHash: live.contentHash,
        assets: live.assets,
      }),
    );
    out.push({
      hash,
      type: 'amendment',
      slug: null,
      title: live.title,
      date: original.date,
      tags: live.tags,
      series: live.series,
      from,
      to: [],
      contentHash: live.contentHash,
      assets: live.assets,
      // §3.9 — an amendment is worth 0 gas and 0 value on purpose, so block
      // aggregation cannot re-charge the word count and research hours already
      // counted in the block that sealed the original. It looks inconsistent
      // beside the metadata below, and is not: the metadata fields (title,
      // tags, series, research) carry the post's NEW declared state, which the
      // renderer reads from the latest amendment; `gasUsed`/`value` are chain
      // accounting, and that accounting was settled when the original sealed.
      gasUsed: 0,
      value: 0,
      research: live.value,
      amends: original.hash,
    });
  }
  return out;
}

export async function buildChain(opts: BuildOptions): Promise<BuildResult> {
  const { config } = opts;
  const from = await identityAddress(config.authorHandle);

  const chain = readLock(opts.lockPath, config.difficulty);

  // §10 — the lock is the source of truth. If it is already inconsistent,
  // fail before appending rather than building on top of a broken ledger.
  const existing = await verifyChain(chain);
  if (!existing.ok) {
    throw new Error(
      `${opts.lockPath} failed verification at ${failureDetail(existing)} — refusing to extend a broken chain`,
    );
  }

  const sealedPeriods = new Set(chain.blocks.map((b) => b.period));
  // Ascending by height, explicitly: `detectAmendments` reads the *last*
  // amendment to a post as the state the chain currently records, so this
  // order decides which body the site is allowed to render. Sorting a copy
  // rather than trusting the lock's array order keeps that from resting on a
  // file-layout assumption.
  const sealedTxs = [...chain.blocks]
    .sort((a, b) => a.height - b.height)
    .flatMap((b) => b.transactions);
  const sealedHashes = new Set(sealedTxs.map((t) => t.hash));
  const sealedPostSlugs = new Set(
    sealedTxs.filter((t) => t.type === 'post').map((t) => t.slug),
  );

  const { txs: live, files: assetFiles } = await readPostTransactions(
    opts.postsDir,
    opts.assetsDir,
    from,
  );
  const amendments = await detectAmendments(sealedTxs, live, from, opts.postsDir);

  // §3.9 — a sealed post's later edits are represented by amendments, not by
  // re-publishing the post. Filtering on hash alone misses this: an edit
  // changes the content hash and therefore the transaction hash, so the new
  // "post" transaction would otherwise slip through as pending and be
  // sealed alongside its own amendment, duplicating the post and compounding
  // on every subsequent edit.
  const pending = [
    ...live.filter((t) => !sealedHashes.has(t.hash) && !sealedPostSlugs.has(t.slug)),
    ...amendments,
  ];

  const lastBlock = chain.blocks.at(-1) ?? null;
  const tipHash = lastBlock ? lastBlock.hash : ZERO_HASH;

  // §3.6 — placement is a recorded fact, not something re-derived from the
  // clock. A pending file written against a different tip describes a history
  // this chain no longer has, so it is ignored rather than trusted; the worst
  // case is that its transactions are placed afresh, which is exactly what
  // would have happened without the file at all.
  const pendingPath = join(dirname(opts.lockPath), PENDING_PATH);
  const recordedFile = readPending(pendingPath);
  const usable =
    recordedFile !== null && !isStale(recordedFile, tipHash) ? recordedFile : null;

  // Keyed on stable identity, not on the transaction hash: the hash is derived
  // from content, so editing a still-pending post re-keys it and orphans its
  // placement. `planChain` bounds these values; nothing is clamped here.
  const recordedPeriods = new Map<string, string>(
    usable === null ? [] : usable.transactions.map((t) => [txIdentity(t), usable.period]),
  );

  const { drafts, open } = planChain(pending, {
    fromPeriod: lastBlock ? lastBlock.period : null,
    now: opts.now,
    maxTxPerBlock: config.maxTxPerBlock,
    recordedPeriods,
  });

  let prev: Block | null = lastBlock;
  let minted = 0;
  let amendmentsSealed = 0;
  const mintedEmpty: string[] = [];

  for (const draft of drafts) {
    // planChain walks from the last sealed period inclusive, so it re-proposes
    // empty blocks for months already on the chain. Drop those. A draft WITH
    // transactions for an already-sealed period is legitimate — it is the
    // remainder of a size-limit split, or a post backdated into that month.
    if (draft.transactions.length === 0 && sealedPeriods.has(draft.period)) continue;

    const merkleRoot = await merkleRootHex(draft.transactions.map((t) => t.hash));
    const header = {
      height: prev ? prev.height + 1 : 0,
      prevHash: prev ? prev.hash : ZERO_HASH,
      merkleRoot,
      timestamp: blockTimestamp(draft, prev ? prev.timestamp : null),
      txCount: draft.transactions.length,
      gasUsed: draft.transactions.reduce((s, t) => s + t.gasUsed, 0),
      difficulty: config.difficulty,
    };
    const { nonce, hash } = mine(header, config.difficulty);

    const block: Block = {
      ...header,
      nonce,
      hash,
      period: draft.period,
      value: Number(draft.transactions.reduce((s, t) => s + t.value, 0).toFixed(1)),
      transactions: draft.transactions,
    };

    chain.blocks.push(block);
    sealedPeriods.add(block.period);
    prev = block;
    minted++;
    if (block.txCount === 0) mintedEmpty.push(block.period);
    amendmentsSealed += draft.transactions.filter((t) => t.type === 'amendment').length;
  }

  // §3.2b — token ids are assigned by first appearance on the chain and are
  // never reassigned. The registry is append-only: an asset whose file is
  // later deleted keeps its identity, because the transaction referencing it
  // is sealed and immutable.
  const known = new Set(chain.assets.map((a) => a.hash));
  for (const block of chain.blocks) {
    for (const tx of block.transactions) {
      for (const hash of tx.assets) {
        if (known.has(hash)) continue;
        const file = assetFiles.get(hash);
        if (!file) {
          throw new Error(
            `asset ${hash} is referenced by block #${block.height} but no file on disk hashes to it — refusing to mint a token with unknown metadata`,
          );
        }
        chain.assets.push({
          tokenId: chain.assets.length + 1,
          hash,
          file: file.file,
          mime: file.mime,
          bytes: file.bytes,
          mintedIn: block.height,
        });
        known.add(hash);
      }
    }
  }

  // §3.6 — difficulty is configurable and changing it must stay safe in both
  // directions. `chain.difficulty` is the chain's floor: the lowest target any
  // block on it was mined at. Leaving it at whatever the lock happened to say
  // made it stale, and it was the sole authority for proof of work — a chain
  // built at 1 and later at 3 still claimed 1. Verification now checks each
  // block against the difficulty committed in its own mined header and uses
  // this value only as the floor, so lowering the config is safe. The floor
  // only ever moves down: raising the config must not retroactively invalidate
  // blocks sealed under the old, lower target, which would brick the ledger.
  chain.difficulty = chain.blocks.reduce((lo, b) => Math.min(lo, b.difficulty), config.difficulty);

  // §10 — never persist a chain that fails its own verification. Without
  // this, a build that produced a broken chain would still write it to
  // disk, and the *next* run would hit the pre-append guard above and
  // refuse to start at all — requiring a manual revert to recover.
  const final = await verifyChain(chain);
  if (!final.ok) {
    throw new Error(
      `build produced an invalid chain at ${failureDetail(final)} — refusing to write ${opts.lockPath}`,
    );
  }

  writeLock(opts.lockPath, chain);

  // Record the open block against the tip as it now stands. Writing this only
  // after the lock is verified and persisted keeps the two consistent: the
  // recorded `prevHash` names a block that is definitely on disk, so the next
  // build's staleness check is meaningful.
  //
  // The period comes from `planChain`, never re-derived here — deriving it a
  // second time is what made placement slide forward on every build.
  const openBlock: PendingLock | null =
    open === null
      ? null
      : {
          version: 1,
          period: open.period,
          height: prev ? prev.height + 1 : 0,
          prevHash: prev ? prev.hash : ZERO_HASH,
          transactions: open.transactions,
        };
  writePending(pendingPath, openBlock);

  // Report the loss this build could actually have caused, not every build in
  // which something is unrecorded.
  //
  // The harm the warning exists to prevent is precise: a month sealing as an
  // empty block while it in fact held a transaction whose placement record was
  // lost. That is observable right here — it happens only when this build mints
  // an empty block for a month at or after where such a transaction could have
  // been waiting. When no empty block was minted, a reassigned placement lands
  // in the same still-open month it was already waiting in, and nothing is
  // denied.
  //
  // Both conditions were measured against the false positives they remove:
  // publishing the first post of a new month (unrecorded by definition, tip a
  // month behind, no empty block) and five new posts sealing four in the
  // current month (an empty block for an older silent month, but the tip is
  // this build's own work in the current month). Neither denies anything.
  const tipPeriod = prev !== null ? prev.period : null;
  const tipMonthIsPast = tipPeriod !== null && tipPeriod < monthOf(opts.now);
  const unrecorded =
    openBlock === null || mintedEmpty.length === 0 || !tipMonthIsPast
      ? []
      : openBlock.transactions.filter((t) => !recordedPeriods.has(txIdentity(t)));

  return { chain, minted, mintedEmpty, amendments: amendmentsSealed, pending: openBlock, unrecorded };
}
