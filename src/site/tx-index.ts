import type { RecordedTx } from './chain-data';
import { getBlocks, getPendingBlock, getPendingPosts, getPosts } from './chain-data';

/**
 * §6 — the ledger flattened into one list: every transaction on the chain,
 * newest first, for `/tx`.
 *
 * The counterpart of `getBlocks()`. That view answers "what did each block
 * seal"; this one answers "what is on the chain, in the order it got there".
 * Different question, same records — read from `src/site/chain-data.ts` and
 * nowhere else, and with no clock (§14), so the same chain builds the same page
 * on any day.
 *
 * **A row is a transaction, and it carries `RecordedTx`.** Not `ResolvedPost`,
 * and the distinction is the whole design of this page. `chain-data.ts` states
 * the rule on `ResolvedPost` itself: "a **block** view still renders
 * `RecordedTx`, because a block card describes what that block sealed and an
 * amendment appears in it as its own row… An address card's rows are not
 * block-scoped — they are 'the posts that sent here' — so they resolve." `/tx`
 * is the first kind of surface. It indexes transactions, so each row is one
 * transaction stating its own committed fields, exactly as `/blocks` does.
 *
 * Resolving here was wrong twice over, and both were shipped and caught. An
 * amended post's row printed the *amendment's* hash, so that hash appeared on
 * two rows while the post transaction's own hash appeared on none — an index
 * that omits one transaction's identity and prints another's twice is not an
 * index. And `/tx` and `/blocks` then gave two different titles for one
 * transaction in one block, with nothing on either page saying why.
 *
 * "What is this post now" is a real question, and `/tx/<slug>` answers it,
 * resolved, with an `Amends` row and an "Đã sửa trong khối #N" notice. That is
 * where a reader who wants the current state clicks through to. This page
 * answers "what is on the chain", and the honest answer to that names each
 * transaction once.
 */

/** One row of the index: one transaction, and what the page needs to place it. */
export interface LedgerRow {
  /** The transaction exactly as the chain recorded it. Never resolved. */
  tx: RecordedTx;
  /** §3.6 — true while the block holding this transaction is the open one. */
  pending: boolean;
  /**
   * The page this transaction belongs to, or `null` when it has none.
   *
   * A post's own page for a post. For an amendment, the page of the post it
   * amends: §3.9 gives an amendment no slug and no page of its own, and
   * `/tx/<slug>` renders the *governing* record — which for the newest
   * amendment is that transaction, so the link lands on the page that shows
   * what this row's transaction says. `null` when the `amends` hash names no
   * post transaction the chain holds: the site links only to what exists.
   */
  href: string | null;
}

export interface TxIndexView {
  /**
   * The open block's transactions, newest first — empty whenever nothing is
   * unsealed, which is most of the time.
   */
  open: LedgerRow[];
  /** The open block's recorded period (`YYYY-MM`), or `null` when there is none. */
  openPeriod: string | null;
  /** Every sealed transaction, newest block first. */
  sealed: LedgerRow[];
  /** `open.length + sealed.length` — one row per transaction on the chain. */
  total: number;
}

/**
 * The page a transaction belongs to, as a slug — its own for a post, the
 * amended post's for an amendment (§3.9), `undefined` when the chain names
 * neither.
 */
function slugFor(tx: RecordedTx, slugOf: ReadonlyMap<string, string>): string | undefined {
  if (tx.type !== 'amendment') return tx.slug ?? undefined;
  return tx.amends === null ? undefined : slugOf.get(tx.amends);
}

/**
 * One block's transactions as rows, newest first.
 *
 * "Newest first" inside a block is the reverse of the order `chain:build`
 * committed them, because that order *is* chain order: §5 sorts a block's
 * transactions by date with amendments last, and the Merkle root commits to
 * exactly that sequence. Sorting these rows by `date` instead would look
 * tidier and be wrong — an amendment carries the date of the post it amends
 * (§3.9), so a correction recorded this month would file itself back among
 * last winter's posts.
 */
function rowsOf(
  txs: readonly RecordedTx[],
  pending: boolean,
  slugOf: ReadonlyMap<string, string>,
): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (let i = txs.length - 1; i >= 0; i -= 1) {
    const tx = txs[i]!;
    const slug = slugFor(tx, slugOf);
    out.push({ tx, pending, href: slug === undefined ? null : `/tx/${slug}` });
  }
  return out;
}

/** §6 — every transaction on the chain, newest first. */
export function transactionIndex(): TxIndexView {
  // Post transactions by hash, so an amendment can name the page of the post it
  // amends. Sealed and pending alike: a post in the open block has a page
  // (§3.6), and an amendment to one would otherwise be the single row on this
  // page that links nowhere.
  const slugOf = new Map<string, string>();
  for (const tx of [...getPosts(), ...getPendingPosts()]) {
    if (tx.slug !== null) slugOf.set(tx.hash, tx.slug);
  }

  const pending = getPendingBlock();
  const open = pending === null ? [] : rowsOf(pending.transactions, true, slugOf);
  // `getBlocks()` is already newest first (§9); the chain reads backwards.
  const sealed = getBlocks().flatMap((b) => rowsOf(b.transactions, false, slugOf));

  return {
    open,
    openPeriod: pending?.period ?? null,
    sealed,
    total: open.length + sealed.length,
  };
}
