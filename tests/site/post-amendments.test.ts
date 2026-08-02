import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeBody, wordCount } from '../../src/chain/canonical';
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
const POST_TITLE = 'Bài viết';
const AMENDED_TITLE = 'Bài viết (đã sửa)';
const ADDR = '0x' + 'c'.repeat(40);
const POST_HASH = '0x' + '11'.repeat(32);
const OTHER_POST_HASH = '0x' + '22'.repeat(32);
const TIP_HASH = '0x' + '99'.repeat(32);
/** The amendment sealed in block #2 — the chain's newest word on the post. */
const SEALED_AMENDMENT = '0x' + 'dd'.repeat(32);
/** An amendment in the still-open block, newer than everything sealed. */
const PENDING_AMENDMENT = '0x' + 'ee'.repeat(32);
/** A second post on the same chain that nothing amends — the control. */
const UNAMENDED_SLUG = 'bai-khac';
const UNAMENDED_HASH = '0x' + '33'.repeat(32);

/**
 * Writes a post file and reports the hash the chain would commit for it —
 * through `parsePost`/`normalizeBody`/`sha256Hex`, the same pipeline
 * `chain:build` uses, so the fixture's recorded hashes are real ones.
 */
async function postOnDisk(
  body: string,
  slug: string = SLUG,
): Promise<{ dir: string; contentHash: Hex; words: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'amend-'));
  const raw = `---\ntitle: "Bài viết"\ndate: 2026-06-15\ntags: [meta]\nresearch: 1.0\n---\n\n${body}\n`;
  const path = join(dir, `${slug}.md`);
  writeFileSync(path, raw);
  const normalized = normalizeBody(parsePost(path, raw).body);
  return { dir, contentHash: await sha256Hex(normalized), words: wordCount(normalized) };
}

/**
 * §3.9 — an amendment carries the post's full new metadata, and carries
 * `gasUsed: 0` / `value: 0` by design so block aggregation cannot re-charge
 * the original's. Every field here differs from the post transaction below, so
 * a page that reads any of them off the original instead can be told apart
 * from one that reads them off the amendment.
 */
function amendment(amends: Hex, contentHash: Hex, hash: Hex): Transaction {
  return {
    hash,
    type: 'amendment',
    slug: null,
    title: AMENDED_TITLE,
    date: '2026-06-15',
    tags: ['meta', 'chain'],
    series: null,
    from: ADDR,
    to: [],
    contentHash,
    assets: [],
    gasUsed: 0,
    value: 0,
    research: 9.5,
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
type OnDisk = { dir: string; contentHash: Hex; words: number };
let v1: OnDisk;
let v2: OnDisk;
let v3: OnDisk;
let v4: OnDisk;
let unrecorded: OnDisk;
/** The unamended control post, on the same chain and in its own directory. */
let other: OnDisk;

beforeAll(async () => {
  // Deliberately different lengths: `gasUsed` is derived from the body (§3.8),
  // so a page reading the original transaction's count instead of recomputing
  // from the body on screen must produce a different number here.
  v1 = await postOnDisk('Phiên bản một.');
  v2 = await postOnDisk('Phiên bản hai.');
  v3 = await postOnDisk('Phiên bản ba, dài hơn hẳn.');
  v4 = await postOnDisk('Phiên bản bốn, dài hơn nữa và thêm vài chữ.');
  unrecorded = await postOnDisk('Một sửa đổi chưa được ghi lại.');
  other = await postOnDisk('Một bài khác, không ai sửa.', UNAMENDED_SLUG);

  const post: Transaction = {
    hash: POST_HASH,
    type: 'post',
    slug: SLUG,
    title: POST_TITLE,
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

  // The control: same chain, no amendment anywhere against it. Its committed
  // `gasUsed` is the real word count of its file, so "recomputed from the body"
  // and "read off the transaction" agree here and disagree for `post` above —
  // which is what makes the amended assertions discriminating.
  const unamended: Transaction = {
    hash: UNAMENDED_HASH,
    type: 'post',
    slug: UNAMENDED_SLUG,
    title: 'Bài khác',
    date: '2026-06-20',
    tags: ['meta'],
    series: null,
    from: ADDR,
    to: [],
    contentHash: other.contentHash,
    assets: [],
    gasUsed: other.words,
    value: 2.5,
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
      block(0, [post, unamended], '0x' + 'aa'.repeat(32)),
      block(1, [amendment(POST_HASH, v2.contentHash, '0x' + 'bb'.repeat(32))], '0x' + 'cc'.repeat(32)),
      block(2, [amendment(POST_HASH, v3.contentHash, SEALED_AMENDMENT)], TIP_HASH),
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
      pendingWith([amendment(POST_HASH, v4.contentHash, PENDING_AMENDMENT)]),
    );

    const content = await getPostContent(SLUG, v4.dir);
    expect(content.contentHash).toBe(v4.contentHash);
    expect(await sha256Hex(content.body)).toBe(content.contentHash);
    // `tx` stays the post's — an amendment has no slug (§3.9), so the original
    // is what a slug resolves to. It is history from here on, not a
    // description of the page: `governing` is what the page must render from.
    expect(content.tx.hash).toBe(POST_HASH);
    expect(content.governing.hash).toBe(PENDING_AMENDMENT);
    expect(content.governing.hash).not.toBe(content.tx.hash);
  });

  it('accepts the body recorded by the newest sealed amendment', async () => {
    const content = await getPostContent(SLUG, v3.dir);
    expect(content.contentHash).toBe(v3.contentHash);
  });

  it('governs the page with the amendment that commits to the body, not the post', async () => {
    // The Critical. The page used to render the amendment's *body* under the
    // original's hash, title, tags, gas and value, stamped `Sealed`: a hash
    // presented as chain-attested that does not commit to the text beside it.
    const content = await getPostContent(SLUG, v3.dir);

    // The hash whose canonical form ends `body:<contentHash of what is shown>`.
    expect(content.governing.hash).toBe(SEALED_AMENDMENT);
    expect(content.governing.contentHash).toBe(await sha256Hex(content.body));

    // Metadata: §3.9 says an amendment carries the post's full new state, and
    // "consumers wanting current tags read the `tags` field of the newest
    // amendment".
    expect(content.governing.title).toBe(AMENDED_TITLE);
    expect(content.governing.title).not.toBe(content.tx.title);
    expect(content.governing.tags).toEqual(['meta', 'chain']);

    // §3.8 — gas is derived from the body, recomputed rather than read off a
    // transaction. The original's count describes text no longer on screen,
    // and the amendment's own is 0 by design.
    expect(content.gasUsed).toBe(wordCount(content.body));
    expect(content.gasUsed).not.toBe(content.tx.gasUsed);
    expect(content.governing.gasUsed).toBe(0);

    // §3.9 — the declared hours live in `research`; `value` stays 0 so block
    // aggregation cannot re-charge them.
    expect(content.value).toBe(9.5);
    expect(content.governing.value).toBe(0);
    expect(content.value).not.toBe(content.tx.value);
  });

  it('names the sealed block holding the amendment, and stamps it sealed', async () => {
    // §3.9 — "The original post page then displays 'Amended in block #N'".
    const content = await getPostContent(SLUG, v3.dir);
    expect(content.amendedIn).toEqual({ height: 2, sealed: true });
    expect(content.pending).toBe(false);
  });

  it('says the amendment is still open rather than naming a block it has not joined', async () => {
    // An open block's height is a prediction a size split can still change, so
    // the notice must not name it, and the panel must not stamp `Sealed` over
    // a transaction the chain has not committed to (§3.6).
    vi.mocked(readPending).mockReturnValue(
      pendingWith([amendment(POST_HASH, v4.contentHash, PENDING_AMENDMENT)]),
    );
    const content = await getPostContent(SLUG, v4.dir);
    expect(content.amendedIn).toEqual({ height: 3, sealed: false });
    expect(content.pending).toBe(true);
  });

  it('leaves an unamended post describing itself', async () => {
    // The control: with no amendment, `governing` IS the post, `gasUsed`
    // recomputes to the transaction's own committed count, and nothing claims
    // an amendment exists. Without this the assertions above are satisfied by
    // an implementation that always prefers an amendment-shaped answer.
    const content = await getPostContent(UNAMENDED_SLUG, other.dir);
    expect(content.governing).toBe(content.tx);
    expect(content.governing.hash).toBe(UNAMENDED_HASH);
    expect(content.gasUsed).toBe(content.tx.gasUsed);
    expect(content.value).toBe(content.tx.value);
    expect(content.amendedIn).toBeNull();
    expect(content.pending).toBe(false);
  });

  it('refuses a body recorded only by a superseded amendment', async () => {
    // v2 was the post's state one amendment ago. The chain's latest word on
    // this post is v3, so rendering v2 would show text the ledger's own newest
    // record contradicts.
    await expect(getPostContent(SLUG, v2.dir)).rejects.toThrow(/does not match the chain/);
  });

  it('prefers the pending amendment over every sealed one', async () => {
    vi.mocked(readPending).mockReturnValue(
      pendingWith([amendment(POST_HASH, v4.contentHash, PENDING_AMENDMENT)]),
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
      ...pendingWith([amendment(POST_HASH, v4.contentHash, PENDING_AMENDMENT)]),
      prevHash: '0x' + '77'.repeat(32),
    });
    await expect(getPostContent(SLUG, v4.dir)).rejects.toThrow(/does not match the chain/);
  });
});
