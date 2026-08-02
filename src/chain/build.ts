import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainConfig } from '../../chain.config';
import { identityAddress } from './address';
import { hashAssetFile, referencedAssets, type AssetFile } from './asset';
import { canonicalAmendmentTx, canonicalPostTx } from './canonical';
import { sha256Hex } from './hash';
import { readLock, writeLock } from './lock';
import { merkleRootHex } from './merkle';
import { mine } from './mine';
import { parsePost, toTransaction } from './post';
import { blockTimestamp, planBlocks } from './seal';
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
  /** Amendment transactions emitted by this build. */
  amendments: number;
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
 * §3.9 — a sealed post whose transaction hash no longer matches produces an
 * amendment transaction rather than a rewrite. Amendments already recorded in
 * the lock are not re-emitted.
 *
 * Detection is on the full `post/1` hash, not the content hash: a retitle, a tag
 * change or a corrected research figure leaves the body untouched, and
 * comparing content hashes would let every such edit vanish — no amendment, no
 * transaction, no warning, and stale metadata on the chain forever.
 */
async function detectAmendments(
  sealed: Transaction[],
  current: Transaction[],
  from: Hex,
  postsDir: string,
): Promise<Transaction[]> {
  const currentBySlug = new Map(current.map((t) => [t.slug, t]));

  const alreadyAmended = new Set<string>();
  for (const tx of sealed) {
    if (tx.type !== 'amendment') continue;
    const state = await stateHash(tx);
    if (state !== null) alreadyAmended.add(`${tx.amends}:${state}`);
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

    if (live.hash === original.hash) continue;
    if (alreadyAmended.has(`${original.hash}:${live.hash}`)) continue;

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
  const sealedTxs = chain.blocks.flatMap((b) => b.transactions);
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
  const drafts = planBlocks(pending, {
    fromPeriod: lastBlock ? lastBlock.period : null,
    now: opts.now,
    maxTxPerBlock: config.maxTxPerBlock,
  });

  let prev: Block | null = lastBlock;
  let minted = 0;
  let amendmentsSealed = 0;

  for (const draft of drafts) {
    // planBlocks walks from the last sealed period inclusive, so it re-proposes
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
  return { chain, minted, amendments: amendmentsSealed };
}
