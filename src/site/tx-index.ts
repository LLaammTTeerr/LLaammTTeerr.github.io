import type { RecordedTx, ResolvedPost } from './chain-data';
import { getBlocks, getPendingBlock, getPendingPosts, getPosts, resolvedPosts } from './chain-data';

/**
 * §6 — the ledger flattened into one list: every transaction on the chain,
 * newest first, for `/tx`.
 *
 * The counterpart of `getBlocks()`. That view answers "what did each block
 * seal"; this one answers "what is on the chain, in the order it got there",
 * which is a different question and so a different walk — but over the same
 * committed records, from `src/site/chain-data.ts` and nowhere else.
 *
 * Reads no clock (§14), like everything under `src/site/`: the order is a
 * function of `chain.lock.json` plus the recorded open block, so the same chain
 * builds the same page on any day.
 *
 * **One row per ledger transaction.** A post transaction contributes a post
 * entry and an amendment contributes an amendment entry — never both for one
 * record, and never neither, so the page's row count is the chain's own
 * transaction count (the number `getStats()` puts on the homepage) rather than
 * a second opinion about it.
 */

/**
 * An amendment as the index renders it.
 *
 * `RecordedTx` narrowed on its own discriminant, so a post transaction cannot
 * reach `AmendmentRow.astro`: `astro check` (`npm run typecheck`) rejects it.
 * The reason is the mirror of `ResolvedPost`'s. `txMetaLine` is safe on an
 * amendment because §3.9 fixes its `gasUsed` and `value` at 0 and the line says
 * where the real figures were counted; handed a **post** it prints that post's
 * sealed word count and hours, which after an amendment is the superseded state
 * — defect shape 1, at a sixth surface. The type is what stops that, not a
 * comment asking the caller to filter first.
 */
export type AmendmentTx = RecordedTx & { type: 'amendment' };

function isAmendment(tx: RecordedTx): tx is AmendmentTx {
  return tx.type === 'amendment';
}

/**
 * A post, as the chain currently describes it (§3.9).
 *
 * `ResolvedPost` and nothing looser: the row this becomes prints the governing
 * record's title, hash, word count and hours, and the resolution is the only
 * thing on this project allowed to decide which record that is.
 */
export interface PostEntry {
  kind: 'post';
  post: ResolvedPost;
}

export interface AmendmentEntry {
  kind: 'amendment';
  tx: AmendmentTx;
  /**
   * §3.9 — the slug of the post this amends, or `null` when the chain holds no
   * post transaction with the hash it names.
   *
   * An amendment has no slug and no page of its own; it belongs to the post it
   * amends, and that post's page is where its title, body and figures are
   * rendered. Resolved here, from the `amends` hash the amendment's own
   * transaction hash covers, so the row links to something committed rather
   * than to a path assembled from a title.
   */
  amendedSlug: string | null;
  /** §3.6 — true while this amendment is still in the open block. */
  pending: boolean;
}

export type TxEntry = PostEntry | AmendmentEntry;

export interface TxIndexView {
  /**
   * The open block's transactions, newest first — empty whenever nothing is
   * unsealed, which is most of the time.
   */
  open: TxEntry[];
  /** The open block's recorded period (`YYYY-MM`), or `null` when there is none. */
  openPeriod: string | null;
  /** Every sealed transaction, newest block first. */
  sealed: TxEntry[];
  /** `open.length + sealed.length` — one row per transaction on the chain. */
  total: number;
}

/**
 * One block's transactions as index entries, newest first.
 *
 * "Newest first" inside a block is the reverse of the order `chain:build`
 * committed them, because that order *is* chain order: §5 sorts a block's
 * transactions by date with amendments last, and the Merkle root commits to
 * exactly that sequence. Sorting these rows by `date` instead would look
 * tidier and be wrong — an amendment carries the date of the post it amends
 * (§3.9), so a correction recorded this month would file itself back among
 * last winter's posts.
 */
function entriesOf(
  txs: readonly RecordedTx[],
  height: number,
  pending: boolean,
  governing: ReadonlyMap<string, ResolvedPost>,
  slugOf: ReadonlyMap<string, string>,
): TxEntry[] {
  const out: TxEntry[] = [];
  for (let i = txs.length - 1; i >= 0; i -= 1) {
    const tx = txs[i]!;
    if (isAmendment(tx)) {
      out.push({
        kind: 'amendment',
        tx,
        amendedSlug: tx.amends === null ? null : (slugOf.get(tx.amends) ?? null),
        pending,
      });
      continue;
    }
    // Every post transaction on the chain has a resolution — `resolvedPosts()`
    // is built from `getPosts()` plus `getPendingPosts()`, which between them
    // are every post transaction there is. A miss means the two walks have
    // diverged, and a page that quietly dropped the row would hide that: the
    // index would be one transaction short of the count it prints beside it.
    const post = governing.get(tx.hash);
    if (post === undefined) {
      throw new Error(
        `no resolved post for transaction ${tx.hash} in block #${height} — ` +
          'resolvedPosts() and the ledger disagree about what a post is',
      );
    }
    out.push({ kind: 'post', post });
  }
  return out;
}

/** §6 — every transaction on the chain, newest first. */
export function transactionIndex(): TxIndexView {
  // Keyed by the *original* transaction's hash, which is what a block holds.
  // `ResolvedPost.hash` is the governing record's and is the amendment's hash
  // after an edit, so keying on that would leave every amended post unfindable
  // from the ledger entry that stands for it.
  const governing = new Map(resolvedPosts().map((p) => [p.originalHash, p]));

  const slugOf = new Map<string, string>();
  for (const tx of [...getPosts(), ...getPendingPosts()]) {
    if (tx.slug !== null) slugOf.set(tx.hash, tx.slug);
  }

  const pending = getPendingBlock();
  const open =
    pending === null ? [] : entriesOf(pending.transactions, pending.height, true, governing, slugOf);
  // `getBlocks()` is already newest first (§9); the chain reads backwards.
  const sealed = getBlocks().flatMap((b) =>
    entriesOf(b.transactions, b.height, false, governing, slugOf),
  );

  return {
    open,
    openPeriod: pending?.period ?? null,
    sealed,
    total: open.length + sealed.length,
  };
}
