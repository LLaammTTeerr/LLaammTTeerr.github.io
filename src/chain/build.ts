import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainConfig } from '../../chain.config';
import { identityAddress } from './address';
import { canonicalAmendmentTx } from './canonical';
import { sha256Hex } from './hash';
import { readLock, writeLock } from './lock';
import { merkleRootHex } from './merkle';
import { mine } from './mine';
import { parsePost, toTransaction } from './post';
import { blockTimestamp, planBlocks } from './seal';
import type { Block, Chain, Hex, Transaction } from './types';
import { verifyChain } from './verify';

const ZERO_HASH = '0x' + '00'.repeat(32);

export interface BuildOptions {
  postsDir: string;
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

function readPostTransactions(postsDir: string, from: Hex): Promise<Transaction[]> {
  const files = readdirSync(postsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return Promise.all(
    files.map((file) => {
      const path = join(postsDir, file);
      return toTransaction(parsePost(path, readFileSync(path, 'utf8')), from);
    }),
  );
}

/**
 * §3.9 — a sealed post whose content hash no longer matches produces an
 * amendment transaction rather than a rewrite. Amendments already recorded in
 * the lock are not re-emitted.
 */
async function detectAmendments(
  sealed: Transaction[],
  current: Transaction[],
  from: Hex,
): Promise<Transaction[]> {
  const currentBySlug = new Map(current.map((t) => [t.slug, t]));
  const alreadyAmended = new Set(
    sealed.filter((t) => t.type === 'amendment').map((t) => `${t.amends}:${t.contentHash}`),
  );

  const out: Transaction[] = [];
  for (const original of sealed) {
    if (original.type === 'amendment') continue;
    const live = currentBySlug.get(original.slug);
    if (!live || live.contentHash === original.contentHash) continue;
    if (alreadyAmended.has(`${original.hash}:${live.contentHash}`)) continue;

    const hash = await sha256Hex(
      canonicalAmendmentTx({
        date: original.date,
        amends: original.hash,
        from,
        contentHash: live.contentHash,
      }),
    );
    out.push({
      hash,
      type: 'amendment',
      slug: null,
      title: null,
      date: original.date,
      tags: [],
      series: null,
      from,
      to: [],
      contentHash: live.contentHash,
      gasUsed: 0,
      value: 0,
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
    const bad = existing.blocks.filter((b) => !b.ok).map((b) => `#${b.height}`);
    throw new Error(
      `${opts.lockPath} failed verification at block ${bad.join(', ')} — refusing to extend a broken chain`,
    );
  }

  const sealedPeriods = new Set(chain.blocks.map((b) => b.period));
  const sealedTxs = chain.blocks.flatMap((b) => b.transactions);
  const sealedHashes = new Set(sealedTxs.map((t) => t.hash));
  const sealedPostSlugs = new Set(
    sealedTxs.filter((t) => t.type === 'post').map((t) => t.slug),
  );

  const live = await readPostTransactions(opts.postsDir, from);
  const amendments = await detectAmendments(sealedTxs, live, from);

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

  // §10 — never persist a chain that fails its own verification. Without
  // this, a build that produced a broken chain would still write it to
  // disk, and the *next* run would hit the pre-append guard above and
  // refuse to start at all — requiring a manual revert to recover.
  const final = await verifyChain(chain);
  if (!final.ok) {
    const bad = final.blocks.filter((b) => !b.ok).map((b) => `#${b.height}`);
    throw new Error(
      `build produced an invalid chain at block ${bad.join(', ')} — refusing to write ${opts.lockPath}`,
    );
  }

  writeLock(opts.lockPath, chain);
  return { chain, minted, amendments: amendmentsSealed };
}
