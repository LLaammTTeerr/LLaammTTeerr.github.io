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
import type { Transaction } from '../../src/chain/types';

const HASH = '0x' + 'a'.repeat(64);
const HASH2 = '0x' + 'b'.repeat(64);
const ADDR = '0x' + 'c'.repeat(40);

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    hash: HASH,
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
    ...overrides,
  };
}

function pendingFixture(overrides: Partial<PendingLock> = {}): PendingLock {
  return {
    version: 1,
    period: '2026-07',
    height: 3,
    prevHash: HASH2,
    transactions: [tx()],
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
    const amendment = tx({ hash: HASH2, type: 'amendment', slug: null, title: null,
      amends: HASH, gasUsed: 0, value: 0, research: 4 });
    const raw = serializePending(pendingFixture({ transactions: [tx(), amendment] }));
    const parsed = JSON.parse(raw) as { transactions: Record<string, unknown>[] };
    expect('research' in parsed.transactions[0]!).toBe(false);
    expect(parsed.transactions[1]!.research).toBe(4);
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
