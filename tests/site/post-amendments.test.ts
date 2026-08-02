import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBody } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';
import { readLock } from '../../src/chain/lock';
import { readPending, type PendingLock } from '../../src/chain/pending';
import { parsePost } from '../../src/chain/post';
import type { Block, Chain, Hex, Transaction } from '../../src/chain/types';
import { getPostContent } from '../../src/site/chain-data';

/**
 * §3.9 — a sealed post that is later edited is represented by an *amendment*,
 * and `getPostContent` must accept the body that amendment recorded. The
 * committed ledger holds one post and no amendments, so the case cannot be
 * exercised against it: both the lock and the pending file are mocked here so
 * a chain with several amendments to one post can be posed.
 *
 * `getChain` memoizes on first read, so one fixture chain serves the whole
 * file and only the pending record and the body on disk vary per test. Vitest
 * gives each test file its own module registry, so this mocking cannot leak
 * into the suites that assert against the real ledger.
 */
vi.mock('../../src/chain/lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chain/lock')>();
  return { ...actual, readLock: vi.fn() };
});
vi.mock('../../src/chain/pending', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/chain/pending')>();
  return { ...actual, readPending: vi.fn() };
});

const SLUG = 'bai-viet';
const ADDR = '0x' + 'c'.repeat(40);
const POST_HASH = '0x' + '11'.repeat(32);
const OTHER_POST_HASH = '0x' + '22'.repeat(32);
const TIP_HASH = '0x' + '99'.repeat(32);

/**
 * Writes a post file and reports the hash the chain would commit for it —
 * through `parsePost`/`normalizeBody`/`sha256Hex`, the same pipeline
 * `chain:build` uses, so the fixture's recorded hashes are real ones.
 */
async function postOnDisk(body: string): Promise<{ dir: string; contentHash: Hex }> {
  const dir = mkdtempSync(join(tmpdir(), 'amend-'));
  const raw = `---\ntitle: "Bài viết"\ndate: 2026-06-15\ntags: [meta]\nresearch: 1.0\n---\n\n${body}\n`;
  const path = join(dir, `${SLUG}.md`);
  writeFileSync(path, raw);
  return { dir, contentHash: await sha256Hex(normalizeBody(parsePost(path, raw).body)) };
}

function amendment(amends: Hex, contentHash: Hex, hash: Hex): Transaction {
  return {
    hash,
    type: 'amendment',
    slug: null,
    title: 'Bài viết',
    date: '2026-06-15',
    tags: ['meta'],
    series: null,
    from: ADDR,
    to: [],
    contentHash,
    assets: [],
    gasUsed: 0,
    value: 0,
    research: 1,
    amends,
  };
}

function block(height: number, transactions: Transaction[], hash: Hex): Block {
  return {
    height,
    prevHash: '0x' + '00'.repeat(32),
    merkleRoot: '0x' + '00'.repeat(32),
    timestamp: `2026-0${height + 6}-01T00:00:00Z`,
    txCount: transactions.length,
    gasUsed: 0,
    difficulty: 5,
    nonce: 1,
    hash,
    period: `2026-0${height + 6}`,
    value: 0,
    transactions,
  };
}

/** v1 sealed, v2 amended, v3 amended again — v3 is the post's current state. */
let v1: { dir: string; contentHash: Hex };
let v2: { dir: string; contentHash: Hex };
let v3: { dir: string; contentHash: Hex };
let v4: { dir: string; contentHash: Hex };
let unrecorded: { dir: string; contentHash: Hex };

beforeAll(async () => {
  v1 = await postOnDisk('Phiên bản một.');
  v2 = await postOnDisk('Phiên bản hai.');
  v3 = await postOnDisk('Phiên bản ba.');
  v4 = await postOnDisk('Phiên bản bốn.');
  unrecorded = await postOnDisk('Một sửa đổi chưa được ghi lại.');

  const post: Transaction = {
    hash: POST_HASH,
    type: 'post',
    slug: SLUG,
    title: 'Bài viết',
    date: '2026-06-15',
    tags: ['meta'],
    series: null,
    from: ADDR,
    to: [],
    contentHash: v1.contentHash,
    assets: [],
    gasUsed: 3,
    value: 1,
    research: null,
    amends: null,
  };

  // Ascending by height, as `readLock` returns it. The older amendment (v2)
  // sits in the lower block, the newer one (v3) in the tip: an implementation
  // that walks the wrong way, or keeps the first match instead of the last,
  // settles on v2 and this fixture says so.
  const chain: Chain = {
    version: 1,
    difficulty: 5,
    blocks: [
      block(0, [post], '0x' + 'aa'.repeat(32)),
      block(1, [amendment(POST_HASH, v2.contentHash, '0x' + 'bb'.repeat(32))], '0x' + 'cc'.repeat(32)),
      block(2, [amendment(POST_HASH, v3.contentHash, '0x' + 'dd'.repeat(32))], TIP_HASH),
    ],
    assets: [],
  };
  vi.mocked(readLock).mockReturnValue(chain);
});

function pendingWith(transactions: Transaction[]): PendingLock {
  return { version: 1, period: '2026-09', height: 3, prevHash: TIP_HASH, transactions };
}

beforeEach(() => {
  vi.mocked(readPending).mockReset();
  vi.mocked(readPending).mockReturnValue(null);
});

describe('getPostContent, on a post the chain has amended', () => {
  it('accepts the body recorded by a pending amendment', async () => {
    // The whole point of the fix: `chain:build` recorded this edit in the open
    // block, so the site may render it. Before, the sealed contentHash was the
    // only hash consulted and this body could never be accepted — no matter how
    // many times the error's own advice was followed.
    vi.mocked(readPending).mockReturnValue(
      pendingWith([amendment(POST_HASH, v4.contentHash, '0x' + 'ee'.repeat(32))]),
    );

    const content = await getPostContent(SLUG, v4.dir);
    expect(content.contentHash).toBe(v4.contentHash);
    expect(await sha256Hex(content.body)).toBe(content.contentHash);
    // The transaction is still the post's — an amendment has no slug (§3.9).
    expect(content.tx.hash).toBe(POST_HASH);
  });

  it('accepts the body recorded by the newest sealed amendment', async () => {
    const content = await getPostContent(SLUG, v3.dir);
    expect(content.contentHash).toBe(v3.contentHash);
  });

  it('refuses a body recorded only by a superseded amendment', async () => {
    // v2 was the post's state one amendment ago. The chain's latest word on
    // this post is v3, so rendering v2 would show text the ledger's own newest
    // record contradicts.
    await expect(getPostContent(SLUG, v2.dir)).rejects.toThrow(/does not match the chain/);
  });

  it('prefers the pending amendment over every sealed one', async () => {
    vi.mocked(readPending).mockReturnValue(
      pendingWith([amendment(POST_HASH, v4.contentHash, '0x' + 'ee'.repeat(32))]),
    );
    // v3 is the newest *sealed* state, but a later amendment is already
    // recorded in the open block, so v3 is no longer what the chain records.
    await expect(getPostContent(SLUG, v3.dir)).rejects.toThrow(/does not match the chain/);
  });

  it('refuses even the sealed body once an amendment supersedes it', async () => {
    // The sealed body is only the current state while nothing amends it. Here
    // the chain's latest word is v3, so rendering v1 would show text the
    // ledger's own newest record contradicts — the same fault as rendering a
    // superseded amendment, and no more acceptable for being the original.
    //
    // This is refusable precisely because it is now recordable: reverting a
    // post to its published text emits an amendment saying so
    // (`detectAmendments` compares against the latest recorded state), so the
    // error's advice works instead of looping.
    await expect(getPostContent(SLUG, v1.dir)).rejects.toThrow(/does not match the chain/);
  });

  // The unamended case — sealed body accepted because the sealed hash *is*
  // the latest record — is covered against the real ledger in
  // `tests/site/content.test.ts`, which carries no amendments. Restating it
  // here with this fixture would prove nothing: every post in it is amended.

  it('refuses a body matching neither the sealed transaction nor any amendment', async () => {
    // The guarantee. An edit made without running `chain:build` is not a
    // recorded value and must still take the build down, naming the file and
    // both hashes.
    const path = join(unrecorded.dir, `${SLUG}.md`);
    await expect(getPostContent(SLUG, unrecorded.dir)).rejects.toThrow(/does not match the chain/);
    await expect(getPostContent(SLUG, unrecorded.dir)).rejects.toThrow(path);
    await expect(getPostContent(SLUG, unrecorded.dir)).rejects.toThrow(
      new RegExp(unrecorded.contentHash.slice(0, 10)),
    );
    await expect(getPostContent(SLUG, unrecorded.dir)).rejects.toThrow(
      new RegExp(v3.contentHash.slice(0, 10)),
    );
  });

  it('refuses a body recorded by an amendment to a different post', async () => {
    // Matching on content hash alone across the whole ledger would let one
    // post's recorded text vouch for another's file.
    vi.mocked(readPending).mockReturnValue(
      pendingWith([amendment(OTHER_POST_HASH, v4.contentHash, '0x' + 'ff'.repeat(32))]),
    );
    await expect(getPostContent(SLUG, v4.dir)).rejects.toThrow(/does not match the chain/);
  });

  it('ignores a pending record written against a different tip', async () => {
    // A stale open block belongs to a history this chain no longer has; its
    // amendment must not admit a body (`getPendingBlock` returns null).
    vi.mocked(readPending).mockReturnValue({
      ...pendingWith([amendment(POST_HASH, v4.contentHash, '0x' + 'ee'.repeat(32))]),
      prevHash: '0x' + '77'.repeat(32),
    });
    await expect(getPostContent(SLUG, v4.dir)).rejects.toThrow(/does not match the chain/);
  });
});
