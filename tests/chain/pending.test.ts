import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPending,
  writePending,
  isStale,
  serializePending,
  PENDING_PATH,
  type PendingLock,
} from '../../src/chain/pending';
import { canonicalRecordedTx } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';
import type { Transaction } from '../../src/chain/types';

const HASH = '0x' + 'a'.repeat(64);
const HASH2 = '0x' + 'b'.repeat(64);
const ADDR = '0x' + 'c'.repeat(40);

/**
 * A transaction carrying the hash the chain would actually commit for its own
 * fields, computed through `sha256Hex` — the project's WebCrypto hasher.
 *
 * `readPending` recomputes the same hash with `node:crypto`, so every fixture
 * built here is also a cross-check that the two hashers agree: if they ever
 * diverged, the round-trip test below would return null instead of the block.
 */
async function recorded(fields: Omit<Transaction, 'hash'>): Promise<Transaction> {
  const canonical = canonicalRecordedTx({ ...fields, hash: HASH });
  if (canonical === null) throw new Error('fixture cannot be canonicalized');
  return { ...fields, hash: await sha256Hex(canonical) };
}

const POST: Transaction = await recorded({
  type: 'post',
  slug: 'bai-viet',
  title: 'Bài viết',
  date: '2026-07-05',
  tags: ['essay'],
  series: null,
  from: ADDR,
  to: [],
  contentHash: HASH2,
  assets: [],
  gasUsed: 12,
  value: 2,
  research: null,
  amends: null,
});

const AMENDMENT: Transaction = await recorded({
  type: 'amendment',
  slug: null,
  title: 'Bài viết (đã sửa)',
  date: '2026-07-05',
  tags: ['essay'],
  series: null,
  from: ADDR,
  to: [],
  contentHash: HASH,
  assets: [],
  gasUsed: 0,
  value: 0,
  research: 4,
  amends: POST.hash,
});

/**
 * A transaction whose hash no longer describes it, unless `overrides` happen
 * to leave every canonical field alone. Used for the corrupt-input cases,
 * where the point is that the file is refused however it got that way.
 */
function tx(overrides: Partial<Transaction> = {}): Transaction {
  return { ...POST, ...overrides };
}

function pendingFixture(overrides: Partial<PendingLock> = {}): PendingLock {
  return {
    version: 1,
    period: '2026-07',
    height: 3,
    prevHash: HASH2,
    transactions: [POST],
    ...overrides,
  };
}

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'pending-')), PENDING_PATH);
}

describe('readPending / writePending', () => {
  it('returns null when the file does not exist', () => {
    expect(readPending(tmpPath())).toBeNull();
  });

  it('round-trips a written pending block', () => {
    const path = tmpPath();
    const pending = pendingFixture();
    writePending(path, pending);
    expect(readPending(path)).toEqual(pending);
  });

  it('deletes the file when there is nothing pending', () => {
    // A stale file would advertise an open block whose transactions have all
    // sealed.
    const path = tmpPath();
    writePending(path, pendingFixture());
    expect(existsSync(path)).toBe(true);
    writePending(path, null);
    expect(existsSync(path)).toBe(false);
    expect(readPending(path)).toBeNull();
  });

  it('is a no-op when asked to delete a file that is not there', () => {
    const path = tmpPath();
    expect(() => writePending(path, null)).not.toThrow();
  });

  it('serializes with 2-space indent, stable key order and a trailing newline', () => {
    const path = tmpPath();
    writePending(path, pendingFixture());
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "period": "2026-07"');
    expect(Object.keys(JSON.parse(raw))).toEqual([
      'version', 'period', 'height', 'prevHash', 'transactions',
    ]);
  });

  it('omits research on a post and keeps it on an amendment, as the lock does', () => {
    const raw = serializePending(pendingFixture({ transactions: [POST, AMENDMENT] }));
    const parsed = JSON.parse(raw) as { transactions: Record<string, unknown>[] };
    expect('research' in parsed.transactions[0]!).toBe(false);
    expect(parsed.transactions[1]!.research).toBe(4);
  });

  it('round-trips a post and an amendment whose hashes recompute from their fields', () => {
    // The positive half of the hash check: an honestly written open block —
    // the only kind `writePending` produces — must still be readable, and both
    // record types must go through the check that rejects a forged one.
    const path = tmpPath();
    const pending = pendingFixture({ transactions: [POST, AMENDMENT] });
    writePending(path, pending);
    const read = readPending(path);
    expect(read, 'a well-formed open block was rejected').not.toBeNull();
    expect(read!.transactions.map((t) => t.hash)).toEqual([POST.hash, AMENDMENT.hash]);
  });

  it("accepts a post whose gasUsed the file got wrong, and leaves it to the view", () => {
    // The boundary, stated deliberately. A post's `gasUsed` is derived (§3.8)
    // and in no canonical form, so this reader cannot authenticate it — and it
    // must not try: it holds only the pending file's path and has no access to
    // `content/posts/`, while `chain:build` calls it for periods alone and
    // would gain a dependency on the content tree for nothing.
    //
    // The figure is re-derived where it is *displayed* instead, by
    // `getPendingBlock` (see `derivedGas` in src/site/chain-data.ts), from the
    // body this transaction's own `contentHash` commits to. So the file is
    // read, and the false number never reaches a page.
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ ...pendingFixture(), transactions: [{ ...POST, gasUsed: 12345 }] }), 'utf8');
    const read = readPending(path);
    expect(read, 'a post with a wrong word count is still a structurally valid record').not.toBeNull();
    expect(read!.transactions[0]!.gasUsed).toBe(12345);
  });

  it('normalizes a missing research field back to null on read', () => {
    const path = tmpPath();
    writePending(path, pendingFixture());
    expect(readPending(path)!.transactions[0]!.research).toBeNull();
  });
});

describe('readPending never throws on a corrupt provisional file', () => {
  // §10 — the lock is the ledger and a corrupt one must stop the build. This
  // file is derivable from content/ plus the lock, so a malformed one must
  // never take the build down; it returns null and placement is reassigned.
  const cases: [string, string][] = [
    ['invalid JSON', '{not json'],
    ['an empty file', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a bare string', '"nope"'],
    ['a wrong version', JSON.stringify({ ...pendingFixture(), version: 2 })],
    ['a missing version', JSON.stringify({ period: '2026-07', height: 1, prevHash: HASH2, transactions: [] })],
    ['a malformed period', JSON.stringify({ ...pendingFixture(), period: '2026-7' })],
    ['a period that is a full date', JSON.stringify({ ...pendingFixture(), period: '2026-07-05' })],
    ['a negative height', JSON.stringify({ ...pendingFixture(), height: -1 })],
    ['a non-integer height', JSON.stringify({ ...pendingFixture(), height: 1.5 })],
    ['a malformed prevHash', JSON.stringify({ ...pendingFixture(), prevHash: 'deadbeef' })],
    ['an uppercase prevHash', JSON.stringify({ ...pendingFixture(), prevHash: '0x' + 'A'.repeat(64) })],
    ['transactions that are not an array', JSON.stringify({ ...pendingFixture(), transactions: {} })],
    ['a null transaction', JSON.stringify({ ...pendingFixture(), transactions: [null] })],
    ['a transaction with a bad hash', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), hash: 'nope' }] })],
    ['a transaction with a bad type', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), type: 'transfer' }] })],
    ['a transaction missing tags', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), tags: undefined }] })],
    // §3.6 — the hash is the transaction's identity, not a field beside it. A
    // well-formed 64-hex-digit value that is not the sha256 of these very
    // fields is a fabrication, and the site would otherwise print it as the
    // chain's own word. Each of these is a hand edit that leaves the file
    // structurally perfect.
    ['a forged transaction hash', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), hash: '0x' + 'de'.repeat(32) }] })],
    ['a tampered title', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), title: 'HOÀN TOÀN BỊA ĐẶT' }] })],
    ['a tampered value', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), value: 999 }] })],
    ['a tampered contentHash', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), contentHash: '0x' + 'ee'.repeat(32) }] })],
    ['tampered tags', JSON.stringify({ ...pendingFixture(), transactions: [{ ...tx(), tags: ['essay', 'chain'] }] })],
    ['a tampered amendment research figure', JSON.stringify({ ...pendingFixture(), transactions: [{ ...AMENDMENT, research: 999 }] })],
    // One good transaction does not vouch for its neighbour.
    ['a second transaction with a forged hash', JSON.stringify({ ...pendingFixture(), transactions: [POST, { ...AMENDMENT, hash: '0x' + 'de'.repeat(32) }] })],
    // §3.9 — an amendment's gasUsed and value are fixed at 0 so block
    // aggregation cannot re-charge the original's. Neither is in the
    // `amendment/1` canonical form (the declared hours travel as `research`),
    // so the hash check above cannot see them: both edits below leave the
    // recorded hash perfectly valid. They are constants, so they are required.
    ['an amendment claiming gas it cannot have', JSON.stringify({ ...pendingFixture(), transactions: [{ ...AMENDMENT, gasUsed: 12345 }] })],
    ['an amendment claiming value it cannot have', JSON.stringify({ ...pendingFixture(), transactions: [{ ...AMENDMENT, value: 999 }] })],
  ];

  for (const [label, raw] of cases) {
    it(`returns null, not a throw, on ${label}`, () => {
      const path = tmpPath();
      writeFileSync(path, raw, 'utf8');
      let result: PendingLock | null | undefined;
      expect(() => { result = readPending(path); }).not.toThrow();
      expect(result).toBeNull();
    });
  }
});

describe('isStale', () => {
  it('is false when the recorded prevHash still matches the tip', () => {
    expect(isStale(pendingFixture({ prevHash: HASH }), HASH)).toBe(false);
  });

  it('is true once a block has sealed on top of the recorded tip', () => {
    // The recorded period was chosen against a different history; honouring it
    // would pin transactions to a month picked for a chain that no longer exists.
    expect(isStale(pendingFixture({ prevHash: HASH }), HASH2)).toBe(true);
  });
});
