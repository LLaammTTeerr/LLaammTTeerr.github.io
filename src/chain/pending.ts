import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { canonicalRecordedTx } from './canonical';
import { orderedTransaction } from './lock';
import type { Hex, Transaction } from './types';
import { transactionStructuralProblem } from './verify';

/**
 * §3.6 — the open block, recorded beside the sealed ledger.
 *
 * `chain.lock.json` is immutable sealed history; this file is openly
 * provisional and rewritten on every build. It exists for one reason: block
 * membership must be a recorded *fact*, assigned once when a transaction first
 * enters the chain. Recomputed from the clock instead, a partial block never
 * seals at any clock — each build re-places its transactions into the
 * then-current month, which is never past, so the month-end half of
 * `isFull || isPast` can never fire. The transaction slides forward forever
 * while the month behind it mints an empty block, recording as silent a month
 * that actually held a pending transaction.
 */
export interface PendingLock {
  version: 1;
  /** YYYY-MM — the recorded placement, which does not slide with the clock. */
  period: string;
  /** The height this block will take once it seals. */
  height: number;
  /** The tip's hash when this was written; makes staleness detectable. */
  prevHash: Hex;
  transactions: Transaction[];
}

export const PENDING_PATH = 'chain.pending.json';

/**
 * The same digest `sha256Hex` produces, computed synchronously.
 *
 * `readPending` is sync and is read from sync template code; WebCrypto's
 * `digest` is not, and making the whole read path async to reach it would
 * change every caller for no gain in what is proved. This module is Node-only
 * already — it reads and deletes files — and nothing here is in `verify.ts`'s
 * browser closure, which imports in the other direction.
 *
 * Only the *hashing* is duplicated, never the canonical form: that comes from
 * `canonicalRecordedTx`, the single definition `verifyBlock` also uses. The
 * two hashers are pinned against each other in `tests/chain/pending.test.ts`,
 * whose fixtures compute their hashes with `sha256Hex` and are then accepted
 * — or rejected — by this one.
 */
function sha256HexSync(data: string): Hex {
  return '0x' + createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Same conventions as the lock: explicit key order, 2-space indent, trailing newline. */
export function serializePending(pending: PendingLock): string {
  const ordered = {
    version: pending.version,
    period: pending.period,
    height: pending.height,
    prevHash: pending.prevHash,
    transactions: pending.transactions.map(orderedTransaction),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

/**
 * Read the open block, or `null` if there isn't a usable one — where "usable"
 * means every recorded transaction's hash recomputes from its own fields, not
 * merely that the file is shaped like an open block.
 *
 * Deliberately total: unlike `readLock`, this **never throws**. The lock is the
 * ledger and a corrupt one must stop the build; this file is provisional and
 * fully derivable from `content/` plus the lock, so a malformed or
 * wrong-version one must never take the build down. The worst case of
 * returning `null` is that placement is reassigned from the clock for
 * transactions that had not sealed anyway — recoverable. Throwing here would
 * mean a hand-edited scratch file bricks `npm run chain:build`.
 */
export function readPending(path: string): PendingLock | null {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  if (p.version !== 1) return null;
  if (typeof p.period !== 'string' || !/^\d{4}-\d{2}$/.test(p.period)) return null;
  if (typeof p.height !== 'number' || !Number.isInteger(p.height) || p.height < 0) return null;
  if (typeof p.prevHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(p.prevHash)) return null;
  if (!Array.isArray(p.transactions)) return null;

  for (const [index, tx] of p.transactions.entries()) {
    if (transactionStructuralProblem(tx, index) !== null) return null;
  }

  const transactions = p.transactions as Transaction[];
  // A transaction serialized without `research` (a post) round-trips as
  // `undefined`; normalize so the in-memory shape matches the lock reader's.
  // Before the hash check, not after: an amendment's `research` participates in
  // its canonical form, so an `undefined` there would fail to canonicalize.
  for (const tx of transactions) {
    if (tx.research === undefined) tx.research = null;
  }

  // §3.6 — "a pending transaction still carries its own real hash". Shape is
  // not realness: `transactionStructuralProblem` checks that `hash` is 64 hex
  // digits, not that it is the sha256 of this transaction's own canonical
  // form. Nothing else ever checks this file — `buildChain` reads it for
  // periods and overwrites it, and `/verify` cannot see the open block at all
  // — so without this a hand-edited or badly merged `chain.pending.json`
  // publishes a fabricated hash, title and value through a green `astro
  // build`. The lock is `verifyChain`'d twice per `chain:build`; this holds
  // the open block to the same standard.
  //
  // Rejecting the whole file rather than the offending transaction, and by
  // returning null rather than throwing: the file is provisional and fully
  // derivable from `content/` plus the lock, so a corrupt one must never take
  // the build down (see the contract above).
  for (const tx of transactions) {
    const canonical = canonicalRecordedTx(tx);
    if (canonical === null || sha256HexSync(canonical) !== tx.hash) return null;
  }

  return {
    version: 1,
    period: p.period,
    height: p.height,
    prevHash: p.prevHash,
    transactions,
  };
}

/** Writes the open block, or deletes the file when there is nothing pending. */
export function writePending(path: string, pending: PendingLock | null): void {
  if (pending === null) {
    // Leaving a stale file behind would advertise an open block that no longer
    // exists — every transaction in it has sealed.
    if (existsSync(path)) rmSync(path);
    return;
  }
  writeFileSync(path, serializePending(pending), 'utf8');
}

/**
 * True when the chain has moved on since this file was written.
 *
 * The recorded period is only meaningful relative to the tip it was recorded
 * against. If blocks sealed since — or the lock was rebuilt, reverted, or
 * replaced — the heights and the placement no longer describe this chain, and
 * honouring them would pin transactions to a month chosen for a different
 * history. A stale file is ignored, not trusted and not fatal.
 */
export function isStale(pending: PendingLock, tipHash: Hex): boolean {
  return pending.prevHash !== tipHash;
}
