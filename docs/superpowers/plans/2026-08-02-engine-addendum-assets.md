# Chain Engine Addendum — Format Reset and Assets

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the canonical format prefixes so each record type is versioned independently, and commit referenced asset files to the post hash so a swapped diagram breaks verification.

**Architecture:** Two changes to the existing, merged chain engine. First a pure rename — `tx/1` → `post/1`, `tx/2` → `amendment/1` — so the numbering stops implying that amendments supersede posts. Then a new `asset.ts` module that hashes referenced files over their raw bytes, plus an `assets:` line in both canonical forms so tampering with an image invalidates the transaction that uses it. Token identity lives in a frozen registry in the lock file, assigned by first appearance on the chain.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, Vitest. No new dependencies.

Implements spec §3.2b and the §3.9 amendment path, from `docs/superpowers/specs/2026-08-02-blockchain-explorer-blog-design.md`.

## Global Constraints

- **Node ≥ 20.** No new dependencies.
- **`src/chain/verify.ts` and its transitive imports** (`canonical.ts`, `hash.ts`, `merkle.ts`, `types.ts`) must never reach a Node built-in or a bare package specifier — that closure is bundled for browsers. `asset.ts` reads files and is therefore **build-time only**; `verify.ts` must not import it.
- **No module under `src/chain/` may read the clock.** No `Date.now()`, no argless `new Date()`.
- **Format prefixes are literal and exact:** `post/1`, `amendment/1`, `block/1`, `addr/1`. Each versions independently from here.
- **Canonical strings join with `\n`** and have no trailing newline.
- **Asset hashes are `sha256` over raw bytes.** No normalization — assets are binary.
- **`assets:` is comma-joined and sorted**, so reference order in the body cannot change a transaction hash.
- Hex is lowercase and `0x`-prefixed. Hashes are 64 hex chars; addresses are 40.
- **`npm run typecheck` and `npm test` must both pass** at the end of every task.
- **Sealed blocks stay immutable.** The one exception is the deliberate one-time re-mine in Task 1, taken while the chain is two blocks long and unpublished.

---

### Task 1: Rename the format prefixes

**Files:**
- Modify: `src/chain/canonical.ts`
- Modify: `tests/chain/canonical.test.ts`
- Modify: `chain.lock.json` (regenerated)
- Test: `tests/chain/canonical.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `canonicalPostTx` emitting `post/1`; `canonicalAmendmentTx` emitting `amendment/1` with no `type:` line.

Posts are `tx/1` and amendments `tx/2` — two different record shapes sharing a version sequence, so `tx/2` reads as superseding `tx/1` when it does not. Each type gets its own prefix and its own version. The `type:amendment` line also goes: the prefix already says so.

- [ ] **Step 1: Update the canonical tests to the new prefixes**

In `tests/chain/canonical.test.ts`, change the expected post form's first element from `'tx/1'` to `'post/1'`:

```ts
    expect(canonicalPostTx(base)).toBe(
      [
        'post/1',
        "title:Mo's Algorithm",
        'date:2026-07-28',
        'tags:algorithm,cp',
        'series:ghi-chu-thuat-toan',
        'research:12.5',
        'from:0xaaaa',
        'body:0xbbbb',
      ].join('\n'),
    );
```

And the amendment form — note `type:amendment` is gone and the prefix carries the meaning:

```ts
    expect(
      canonicalAmendmentTx({
        amends: '0xdead',
        date: '2026-07-28',
        title: 'Tiêu đề mới',
        tags: ['cp'],
        series: null,
        research: 3,
        from: '0xaaaa',
        contentHash: '0xbeef',
      }),
    ).toBe(
      [
        'amendment/1',
        'amends:0xdead',
        'date:2026-07-28',
        'title:Tiêu đề mới',
        'tags:cp',
        'series:',
        'research:3.0',
        'from:0xaaaa',
        'body:0xbeef',
      ].join('\n'),
    );
```

Add a test pinning that the two forms cannot collide:

```ts
  it('gives posts and amendments distinct, independently versioned prefixes', () => {
    expect(canonicalPostTx(base).startsWith('post/1\n')).toBe(true);
    expect(
      canonicalAmendmentTx({
        amends: '0xdead', date: '2026-07-28', title: 'x', tags: [],
        series: null, research: 0, from: '0xaaaa', contentHash: '0xbeef',
      }).startsWith('amendment/1\n'),
    ).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/chain/canonical.test.ts`
Expected: FAIL — the implementation still emits `tx/1` and `tx/2`, and still includes `type:amendment`.

- [ ] **Step 3: Rename the prefixes in the implementation**

In `src/chain/canonical.ts`, change `canonicalPostTx`'s first array element from `'tx/1'` to `'post/1'`. Change `canonicalAmendmentTx`'s first element from `'tx/2'` to `'amendment/1'` and **delete the `'type:amendment'` line entirely**.

Replace the doc comment on `canonicalAmendmentTx` with:

```ts
/**
 * §3.9 — the amendment form.
 *
 * Each record type carries its own prefix and its own version, bumped only when
 * that type's format changes. `post/1` and `amendment/1` are different shapes,
 * not two versions of one thing, so they never share a number.
 *
 * An edit to a sealed post may change nothing but its metadata: a retitle, a
 * new tag, a corrected research figure. The post form covers those fields, so
 * an amendment must too — otherwise a metadata-only edit produces no hash
 * change, no amendment, and the ledger keeps the stale values forever.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/chain/canonical.test.ts` — Expected: PASS.
Then the full suite: `npm test`. The build golden snapshot **will fail**, because every transaction hash changed. That is expected and correct.

- [ ] **Step 5: Regenerate the golden snapshot deliberately**

Run: `npx vitest run tests/chain/build.test.ts -u`

Then inspect the diff: `git diff tests/chain/__snapshots__/build.test.ts.snap`

Confirm that transaction hashes, merkle roots, block hashes and nonces all changed, and that **nothing structural changed** — same block count, same periods, same transaction slugs, same gas and value figures. If a field other than a hash or nonce moved, stop and investigate before committing.

Run `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 6: Re-mine the real chain**

The committed ledger was mined under the old prefixes, so its hashes no longer match what the code produces. Regenerate it:

```bash
rm chain.lock.json
npm run chain:build -- --now=2026-08-02
```

Expected: mines two blocks at difficulty 5 (a few seconds), prints `integrity   OK`.

Confirm it is stable: run the same command again and check `git diff --stat chain.lock.json` reports no change on the second run.

- [ ] **Step 7: Commit**

```bash
git add src/chain/canonical.ts tests/chain/canonical.test.ts \
        tests/chain/__snapshots__/build.test.ts.snap chain.lock.json
git commit -m "refactor(chain): version each record type independently

post/1 and amendment/1 are different record shapes, not two versions of one
thing; sharing a tx/N sequence implied amendments superseded posts. The
type:amendment line goes too — the prefix already says so.

Re-mines the ledger, taken deliberately while the chain is two blocks and
unpublished."
```

---

### Task 2: The asset module

**Files:**
- Create: `src/chain/asset.ts`
- Test: `tests/chain/asset.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` from `src/chain/hash`, `Hex` from `src/chain/types`.
- Produces:
  - `mimeTypeFor(file: string): string`
  - `referencedAssets(body: string): string[]` — filenames, first-appearance order, deduped
  - `interface AssetFile { file: string; hash: Hex; mime: string; bytes: number }`
  - `hashAssetFile(assetsDir: string, file: string, referencedBy: string): Promise<AssetFile>`

This module reads files, so it is build-time only. `verify.ts` must never import it.

- [ ] **Step 1: Write the failing test**

Create `tests/chain/asset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeTypeFor, referencedAssets, hashAssetFile } from '../../src/chain/asset';
import { sha256Hex } from '../../src/chain/hash';

describe('mimeTypeFor', () => {
  it('maps the formats a post is likely to embed', () => {
    expect(mimeTypeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeTypeFor('a.png')).toBe('image/png');
    expect(mimeTypeFor('a.jpg')).toBe('image/jpeg');
    expect(mimeTypeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('a.pdf')).toBe('application/pdf');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeTypeFor('DIAGRAM.PNG')).toBe('image/png');
  });

  it('falls back rather than guessing', () => {
    expect(mimeTypeFor('a.xyz')).toBe('application/octet-stream');
    expect(mimeTypeFor('noextension')).toBe('application/octet-stream');
  });
});

describe('referencedAssets', () => {
  it('finds a markdown image', () => {
    expect(referencedAssets('![sơ đồ](/assets/mo-blocks.svg)')).toEqual(['mo-blocks.svg']);
  });

  it('finds a markdown link', () => {
    expect(referencedAssets('[tải về](/assets/de-bai.pdf)')).toEqual(['de-bai.pdf']);
  });

  it('finds an html img tag', () => {
    expect(referencedAssets('<img src="/assets/chart.png" alt="x">')).toEqual(['chart.png']);
  });

  it('accepts a markdown image with a title', () => {
    expect(referencedAssets('![a](/assets/x.svg "tiêu đề")')).toEqual(['x.svg']);
  });

  it('dedupes repeated references, keeping first-appearance order', () => {
    const body = '![a](/assets/b.svg)\n![c](/assets/a.svg)\n![d](/assets/b.svg)';
    expect(referencedAssets(body)).toEqual(['b.svg', 'a.svg']);
  });

  it('ignores a bare mention that is not a link or an image', () => {
    expect(referencedAssets('the file lives at /assets/x.svg in the repo')).toEqual([]);
  });

  it('ignores an external url', () => {
    expect(referencedAssets('![a](https://example.com/assets/x.svg)')).toEqual([]);
  });

  it('returns an empty array for a body with no assets', () => {
    expect(referencedAssets('chỉ là văn bản thường.')).toEqual([]);
  });
});

describe('hashAssetFile', () => {
  function tempAssets(): string {
    return mkdtempSync(join(tmpdir(), 'assets-'));
  }

  it('hashes the raw bytes, not a normalized string', async () => {
    const dir = tempAssets();
    // Trailing whitespace and CRLF must survive: assets are binary.
    const contents = 'a\r\n  \r\n';
    writeFileSync(join(dir, 'x.svg'), contents);
    const asset = await hashAssetFile(dir, 'x.svg', 'post.md');
    expect(asset.hash).toBe(await sha256Hex(contents));
  });

  it('reports file, mime and byte size', async () => {
    const dir = tempAssets();
    writeFileSync(join(dir, 'chart.png'), 'abcde');
    const asset = await hashAssetFile(dir, 'chart.png', 'post.md');
    expect(asset.file).toBe('chart.png');
    expect(asset.mime).toBe('image/png');
    expect(asset.bytes).toBe(5);
  });

  it('is deterministic', async () => {
    const dir = tempAssets();
    writeFileSync(join(dir, 'x.svg'), 'same');
    expect((await hashAssetFile(dir, 'x.svg', 'p.md')).hash)
      .toBe((await hashAssetFile(dir, 'x.svg', 'p.md')).hash);
  });

  it('fails loudly when the referenced file is missing, naming the post', async () => {
    const dir = tempAssets();
    await expect(hashAssetFile(dir, 'gone.svg', 'content/posts/2026-08-05-x.md'))
      .rejects.toThrow(/2026-08-05-x\.md.*gone\.svg/s);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chain/asset.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/asset`.

- [ ] **Step 3: Implement `src/chain/asset.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { sha256Hex } from './hash';
import type { Hex } from './types';

/**
 * §3.2b — assets are files a post references. This module reads the
 * filesystem and is therefore BUILD-TIME ONLY: `verify.ts` must never import
 * it, or the browser bundle breaks.
 */

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};

export function mimeTypeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Every `/assets/<file>` a post links or embeds, in first-appearance order,
 * deduped. Matching requires markdown-link or `<img src>` context, so a bare
 * mention of a path in prose or a code sample is not a reference.
 */
export function referencedAssets(body: string): string[] {
  const out: string[] = [];
  const add = (file: string): void => {
    if (!out.includes(file)) out.push(file);
  };

  const patterns = [
    /\]\(\s*\/assets\/([A-Za-z0-9._-]+)/g,
    /<img\b[^>]*\bsrc=["']\/assets\/([A-Za-z0-9._-]+)["']/g,
  ];

  // Collect with positions so the merged result keeps document order.
  const found: Array<{ at: number; file: string }> = [];
  for (const re of patterns) {
    for (const m of body.matchAll(re)) {
      found.push({ at: m.index ?? 0, file: m[1]! });
    }
  }
  found.sort((a, b) => a.at - b.at);
  for (const f of found) add(f.file);
  return out;
}

export interface AssetFile {
  file: string;
  hash: Hex;
  mime: string;
  bytes: number;
}

/**
 * Hash an asset over its RAW BYTES. Assets are binary; the text
 * normalization applied to post bodies would corrupt them.
 */
export async function hashAssetFile(
  assetsDir: string,
  file: string,
  referencedBy: string,
): Promise<AssetFile> {
  const path = join(assetsDir, file);
  if (!existsSync(path)) {
    throw new Error(
      `${referencedBy}: references /assets/${file}, which does not exist in ${assetsDir}`,
    );
  }
  const buf = readFileSync(path);
  return {
    file,
    hash: await sha256Hex(new Uint8Array(buf)),
    mime: mimeTypeFor(file),
    bytes: buf.byteLength,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/chain/asset.test.ts` — Expected: PASS, 15 tests.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 5: Commit**

```bash
git add src/chain/asset.ts tests/chain/asset.test.ts
git commit -m "feat(chain): add asset hashing and reference discovery"
```

---

### Task 3: `assets:` in the canonical forms

**Files:**
- Modify: `src/chain/types.ts`
- Modify: `src/chain/canonical.ts`
- Modify: `tests/chain/canonical.test.ts`
- Modify: `tests/chain/lock.test.ts` (fixture gains the new field)
- Test: `tests/chain/canonical.test.ts`

**Interfaces:**
- Consumes: `Hex` from `src/chain/types`.
- Produces:
  - `Transaction` gains `assets: Hex[]`
  - `CanonicalPostFields` and `CanonicalAmendmentFields` each gain `assets: Hex[]`
  - Both canonical forms emit an `assets:` line immediately before `body:`

- [ ] **Step 1: Write the failing test**

Add to `tests/chain/canonical.test.ts`, inside the `canonicalPostTx` describe:

```ts
  it('emits assets immediately before body', () => {
    expect(canonicalPostTx({ ...base, assets: ['0x22', '0x11'] })).toBe(
      [
        'post/1',
        "title:Mo's Algorithm",
        'date:2026-07-28',
        'tags:algorithm,cp',
        'series:ghi-chu-thuat-toan',
        'research:12.5',
        'from:0xaaaa',
        'assets:0x11,0x22',
        'body:0xbbbb',
      ].join('\n'),
    );
  });

  it('sorts assets so reference order in the body cannot change the hash', () => {
    expect(canonicalPostTx({ ...base, assets: ['0x22', '0x11'] })).toBe(
      canonicalPostTx({ ...base, assets: ['0x11', '0x22'] }),
    );
  });

  it('emits an empty assets line for a post with no assets', () => {
    expect(canonicalPostTx({ ...base, assets: [] })).toContain('\nassets:\n');
  });

  it('changes the canonical form when an asset changes', () => {
    expect(canonicalPostTx({ ...base, assets: ['0x11'] }))
      .not.toBe(canonicalPostTx({ ...base, assets: ['0x99'] }));
  });
```

Add `assets: []` to the shared `base` object in that file.

Add to the `canonicalAmendmentTx` describe:

```ts
  it('carries assets so replacing an image produces an amendment', () => {
    const fields = {
      amends: '0xdead', date: '2026-07-28', title: 'x', tags: [],
      series: null, research: 0, from: '0xaaaa', contentHash: '0xbeef',
    };
    expect(canonicalAmendmentTx({ ...fields, assets: ['0x11'] }))
      .not.toBe(canonicalAmendmentTx({ ...fields, assets: ['0x99'] }));
    expect(canonicalAmendmentTx({ ...fields, assets: ['0x11'] })).toContain('\nassets:0x11\n');
  });
```

Update the existing amendment expectation to include `'assets:'` before `'body:0xbeef'`, and pass `assets: []` in that call.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chain/canonical.test.ts`
Expected: FAIL — `assets` is not a property of the field types, and no `assets:` line is emitted.

- [ ] **Step 3: Add `assets` to the transaction type**

In `src/chain/types.ts`, add to `Transaction`, immediately after `contentHash`:

```ts
  /**
   * §3.2b — content hashes of the files this transaction's body references,
   * sorted. Committed to the transaction hash, so swapping a published
   * diagram invalidates the post that uses it.
   */
  assets: Hex[];
```

- [ ] **Step 4: Add the `assets:` line to both canonical forms**

In `src/chain/canonical.ts`, add `assets: Hex[];` to both `CanonicalPostFields` and `CanonicalAmendmentFields`.

In `canonicalPostTx`, insert immediately before the `body:` element:

```ts
    `assets:${[...p.assets].sort().join(',')}`,
```

In `canonicalAmendmentTx`, insert the same line before its `body:` element, using `a.assets`.

Sorting is what makes the hash independent of the order images appear in the body.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/chain/canonical.test.ts` — Expected: PASS.

`npm run typecheck` will now fail in `post.ts`, `build.ts`, `verify.ts` and `lock.test.ts`, because `Transaction` gained a required field. That is expected — Task 4 wires them up. To keep this task's commit green, add `assets: []` at each construction site:

- `src/chain/post.ts` — in the object returned by `toTransaction`
- `src/chain/build.ts` — in the amendment object built by `detectAmendments`
- `tests/chain/verify.test.ts` — in the `tx()` helper
- `tests/chain/build.test.ts` — nothing, transactions come from the real path
- `tests/chain/lock.test.ts` — both fixture transactions, with `assets: []` on the post and `assets: []` on the amendment; also add `assets` to the expected `Object.keys()` arrays, positioned immediately after `contentHash`

Also add `assets` to `orderedTransaction` in `src/chain/lock.ts`, immediately after `contentHash`, so the field is serialized:

```ts
    contentHash: t.contentHash,
    assets: t.assets,
    gasUsed: t.gasUsed,
```

Then pass `assets` through at the two `canonicalPostTx` / `canonicalAmendmentTx` call sites in `src/chain/post.ts` and `src/chain/build.ts`, and at the two in `src/chain/verify.ts`'s `expectedTxHash`, sourcing it from `tx.assets`.

Run `npm test` and `npm run typecheck`. The golden snapshot fails again — hashes changed. Regenerate deliberately with `npx vitest run tests/chain/build.test.ts -u`, inspect the diff to confirm only hashes and nonces moved plus a new `"assets": []` on each transaction, then re-run `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/chain/types.ts src/chain/canonical.ts src/chain/lock.ts \
        src/chain/post.ts src/chain/build.ts src/chain/verify.ts \
        tests/chain/canonical.test.ts tests/chain/lock.test.ts \
        tests/chain/verify.test.ts tests/chain/__snapshots__/build.test.ts.snap
git commit -m "feat(chain): commit referenced assets to the transaction hash"
```

---

### Task 4: Resolve assets during the build, and mint token identities

**Files:**
- Modify: `src/chain/types.ts`
- Modify: `src/chain/post.ts`
- Modify: `src/chain/build.ts`
- Modify: `src/chain/lock.ts`
- Modify: `tests/chain/post.test.ts`
- Test: `tests/chain/build.test.ts`

**Interfaces:**
- Consumes: `hashAssetFile`, `referencedAssets`, `AssetFile` from `src/chain/asset`.
- Produces:
  - `interface AssetRecord { tokenId: number; hash: Hex; file: string; mime: string; bytes: number; mintedIn: number }`
  - `Chain` gains `assets: AssetRecord[]`
  - `toTransaction(post: PostInput, from: Hex, assets: AssetFile[]): Promise<Transaction>`
  - `BuildOptions` gains `assetsDir: string`

- [ ] **Step 1: Write the failing tests**

In `tests/chain/post.test.ts`, update the `toTransaction` calls to pass an assets array (`[]` for existing cases) and add:

```ts
  it('commits asset hashes to the transaction hash', async () => {
    const post = parsePost('a/x.md', RAW);
    const withAsset = await toTransaction(post, '0xauthor', [
      { file: 'a.svg', hash: '0x11', mime: 'image/svg+xml', bytes: 10 },
    ]);
    const without = await toTransaction(post, '0xauthor', []);
    expect(withAsset.hash).not.toBe(without.hash);
    expect(withAsset.assets).toEqual(['0x11']);
  });

  it('sorts committed asset hashes', async () => {
    const post = parsePost('a/x.md', RAW);
    const tx = await toTransaction(post, '0xauthor', [
      { file: 'b.svg', hash: '0x22', mime: 'image/svg+xml', bytes: 1 },
      { file: 'a.svg', hash: '0x11', mime: 'image/svg+xml', bytes: 1 },
    ]);
    expect(tx.assets).toEqual(['0x11', '0x22']);
  });
```

In `tests/chain/build.test.ts`, extend `workspace()` to create an assets directory and return it, and pass `assetsDir` in every `buildChain` call:

```ts
function workspace(): { postsDir: string; assetsDir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chain-build-'));
  const postsDir = join(dir, 'posts');
  const assetsDir = join(dir, 'assets');
  cpSync('tests/fixtures/posts', postsDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  return { postsDir, assetsDir, lockPath: join(dir, 'chain.lock.json') };
}
```

Import `mkdirSync` from `node:fs`. Then add:

```ts
  it('mints a token for a referenced asset', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'so-do.svg'), '<svg/>');
    writeFileSync(
      join(postsDir, '2026-07-20-hinh.md'),
      '---\ntitle: "Có hình"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![sơ đồ](/assets/so-do.svg)\n',
    );
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    expect(chain.assets).toHaveLength(1);
    expect(chain.assets[0]!.tokenId).toBe(1);
    expect(chain.assets[0]!.file).toBe('so-do.svg');
    expect(chain.assets[0]!.mime).toBe('image/svg+xml');
    expect(chain.assets[0]!.mintedIn).toBe(1);
    const tx = chain.blocks.flatMap((b) => b.transactions).find((t) => t.slug === '2026-07-20-hinh');
    expect(tx!.assets).toEqual([chain.assets[0]!.hash]);
  });

  it('assigns token ids by first appearance and never reassigns them', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'a.svg'), 'A');
    writeFileSync(
      join(postsDir, '2026-07-20-one.md'),
      '---\ntitle: "Một"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![a](/assets/a.svg)\n',
    );
    const first = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const tokenOne = first.chain.assets[0]!;

    writeFileSync(join(assetsDir, 'b.svg'), 'B');
    writeFileSync(
      join(postsDir, '2026-09-05-two.md'),
      '---\ntitle: "Hai"\ndate: 2026-09-05\ntags: [cp]\n---\n\n![b](/assets/b.svg)\n',
    );
    const second = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(second.chain.assets[0]).toEqual(tokenOne);
    expect(second.chain.assets[1]!.tokenId).toBe(2);
    expect(second.chain.assets[1]!.file).toBe('b.svg');
  });

  it('emits an amendment when a referenced image is replaced', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'a.svg'), 'ORIGINAL');
    writeFileSync(
      join(postsDir, '2026-07-20-one.md'),
      '---\ntitle: "Một"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![a](/assets/a.svg)\n',
    );
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    writeFileSync(join(assetsDir, 'a.svg'), 'SWAPPED');
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(after.amendments).toBe(1);
    expect(after.chain.assets).toHaveLength(2);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('fails the build when a post references a missing asset', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(
      join(postsDir, '2026-07-20-broken.md'),
      '---\ntitle: "Thiếu"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![x](/assets/khong-co.svg)\n',
    );
    await expect(
      buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG }),
    ).rejects.toThrow(/khong-co\.svg/);
  });

  it('leaves an unreferenced file off the chain entirely', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'unused.png'), 'nobody links to me');
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(chain.assets).toEqual([]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/chain/post.test.ts tests/chain/build.test.ts`
Expected: FAIL — `toTransaction` takes two arguments, `BuildOptions` has no `assetsDir`, `Chain` has no `assets`.

- [ ] **Step 3: Add the asset record type**

In `src/chain/types.ts`:

```ts
/** §3.2b — a minted asset's frozen identity on the chain. */
export interface AssetRecord {
  tokenId: number;
  hash: Hex;
  file: string;
  mime: string;
  bytes: number;
  /** Height of the block whose transaction first referenced this asset. */
  mintedIn: number;
}
```

And add to `Chain`:

```ts
  assets: AssetRecord[];
```

- [ ] **Step 4: Take assets in `toTransaction`**

In `src/chain/post.ts`, import `AssetFile`:

```ts
import type { AssetFile } from './asset';
```

Change the signature and body:

```ts
export async function toTransaction(
  post: PostInput,
  from: Hex,
  assets: AssetFile[],
): Promise<Transaction> {
  const normalized = normalizeBody(post.body);
  const contentHash = await sha256Hex(normalized);
  const assetHashes = assets.map((a) => a.hash).sort();

  const hash = await sha256Hex(
    canonicalPostTx({
      title: post.title,
      date: post.date,
      tags: post.tags,
      series: post.series,
      research: post.research,
      from,
      assets: assetHashes,
      contentHash,
    }),
  );
```

and set `assets: assetHashes` in the returned object, replacing the `assets: []` added in Task 3.

- [ ] **Step 5: Resolve assets and mint tokens in the build**

In `src/chain/build.ts`:

Import:

```ts
import { hashAssetFile, referencedAssets, type AssetFile } from './asset';
import type { AssetRecord, Block, Chain, Hex, Transaction } from './types';
```

Add `assetsDir: string;` to `BuildOptions`.

Replace `readPostTransactions` with a version that resolves assets. It also needs to return the resolved `AssetFile`s so the registry can record file, mime and size:

```ts
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
```

Note that `files` is keyed by hash, so two files with byte-identical contents
collapse to one entry and therefore one token. That is correct — assets are
content-addressed, and two copies of the same bytes are the same asset. Do not
"fix" it by keying on filename.

Update the call site in `buildChain`:

```ts
  const { txs: live, files: assetFiles } = await readPostTransactions(
    opts.postsDir,
    opts.assetsDir,
    from,
  );
```

and change every later use of `live` accordingly (it was already a `Transaction[]`, so only the destructuring changes).

`detectAmendments` builds the amendment's canonical form from the live post's state — pass the live transaction's `assets` through to `canonicalAmendmentTx` and set `assets: live.assets` on the amendment object it constructs, replacing the `assets: []` from Task 3.

After the mint loop and before `writeLock`, assign token identities:

```ts
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
```

Place this after the block-minting loop and before the post-mint `verifyChain` call.

- [ ] **Step 6: Serialize the registry**

In `src/chain/lock.ts`:

- `emptyChain` returns `{ version: 1, difficulty, blocks: [], assets: [] }`.
- Add an `orderedAsset` projection mirroring the others:

```ts
function orderedAsset(a: AssetRecord): AssetRecord {
  return {
    tokenId: a.tokenId,
    hash: a.hash,
    file: a.file,
    mime: a.mime,
    bytes: a.bytes,
    mintedIn: a.mintedIn,
  };
}
```

- `serializeChain` emits `assets: chain.assets.map(orderedAsset)` after `blocks`.
- `readLock` validates it, alongside the existing `blocks` check:

```ts
  if (!Array.isArray(chain.assets)) {
    throw new Error(`${path} is missing a valid "assets" array — refusing to use a corrupt ledger`);
  }
```

Import `AssetRecord` from `./types`.

- [ ] **Step 7: Update the CLI**

In `scripts/build-chain.ts`, add `assetsDir: 'content/assets'` to the `buildChain` call, and add a line to the summary output after `txns`:

```ts
console.log(`  assets      ${chain.assets.length}`);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/chain/post.test.ts tests/chain/build.test.ts` — Expected: PASS.

The golden snapshot changes again (transactions gain `assets`, the chain gains an `assets` array). Regenerate with `npx vitest run tests/chain/build.test.ts -u`, inspect the diff, then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 9: Commit**

```bash
git add src/chain/types.ts src/chain/post.ts src/chain/build.ts src/chain/lock.ts \
        scripts/build-chain.ts tests/chain/post.test.ts tests/chain/build.test.ts \
        tests/chain/lock.test.ts tests/chain/__snapshots__/build.test.ts.snap
git commit -m "feat(chain): mint token identities for referenced assets"
```

---

### Task 5: Verify the registry, and re-mine the real chain

**Files:**
- Modify: `src/chain/verify.ts`
- Modify: `tests/chain/verify.test.ts`
- Create: `content/assets/.gitkeep`
- Modify: `chain.lock.json` (regenerated)
- Test: `tests/chain/verify.test.ts`

**Interfaces:**
- Consumes: `Chain`, `AssetRecord` from `src/chain/types`.
- Produces: `verifyChain` additionally checking the asset registry; `BlockVerification` unchanged.

The registry is derived data that lives outside the mined header, so nothing forces it to agree with the transactions. A reader trusting `/assets` deserves the same guarantee as one trusting a block.

- [ ] **Step 1: Write the failing test**

Add to `tests/chain/verify.test.ts`:

```ts
describe('asset registry', () => {
  async function chainWithAsset() {
    const t = { ...tx('a'), assets: ['0x' + '1a'.repeat(32)] };
    const b0 = await makeBlock(0, ZERO, [t]);
    return {
      version: 1 as const,
      difficulty: DIFFICULTY,
      blocks: [b0],
      assets: [{
        tokenId: 1, hash: '0x' + '1a'.repeat(32), file: 'a.svg',
        mime: 'image/svg+xml', bytes: 10, mintedIn: 0,
      }],
    };
  }

  it('accepts a registry consistent with the transactions', async () => {
    expect((await verifyChain(await chainWithAsset())).ok).toBe(true);
  });

  it('rejects a referenced asset that has no registry entry', async () => {
    const chain = await chainWithAsset();
    chain.assets = [];
    expect((await verifyChain(chain)).ok).toBe(false);
  });

  it('rejects a registry entry no transaction references', async () => {
    const chain = await chainWithAsset();
    chain.assets.push({
      tokenId: 2, hash: '0x' + '2b'.repeat(32), file: 'ghost.svg',
      mime: 'image/svg+xml', bytes: 1, mintedIn: 0,
    });
    expect((await verifyChain(chain)).ok).toBe(false);
  });

  it('rejects a wrong mint block', async () => {
    const chain = await chainWithAsset();
    chain.assets[0]!.mintedIn = 5;
    expect((await verifyChain(chain)).ok).toBe(false);
  });

  it('rejects non-sequential token ids', async () => {
    const chain = await chainWithAsset();
    chain.assets[0]!.tokenId = 7;
    expect((await verifyChain(chain)).ok).toBe(false);
  });

  it('does not throw on a malformed registry', async () => {
    const chain = await chainWithAsset();
    (chain as unknown as { assets: unknown }).assets = 'not an array';
    await expect(verifyChain(chain)).resolves.toBeDefined();
    expect((await verifyChain(chain)).ok).toBe(false);
  });
});
```

Add `assets: []` to the `tx()` helper's returned object if Task 3 did not already, and `assets: []` to any chain literal built in that file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chain/verify.test.ts`
Expected: FAIL — `verifyChain` ignores the registry, so every tampered case still reports `ok: true`.

- [ ] **Step 3: Verify the registry**

In `src/chain/verify.ts`, add above `verifyChain`:

```ts
/**
 * §3.2b — the asset registry is derived data outside the mined header, so it
 * needs its own check: every referenced hash has exactly one entry, every
 * entry is referenced, mint blocks match first appearance, and token ids run
 * 1..n in that same order. Total over untrusted input, like the rest of this
 * module.
 */
function registryProblem(chain: Chain): string | null {
  if (!Array.isArray(chain.assets)) return 'assets is not an array';

  const firstSeen = new Map<Hex, number>();
  const order: Hex[] = [];
  for (const block of chain.blocks) {
    if (!Array.isArray(block.transactions)) continue;
    for (const tx of block.transactions) {
      if (!Array.isArray(tx.assets)) continue;
      for (const hash of tx.assets) {
        if (firstSeen.has(hash)) continue;
        firstSeen.set(hash, block.height);
        order.push(hash);
      }
    }
  }

  if (chain.assets.length !== order.length) {
    return `registry holds ${chain.assets.length} assets but transactions reference ${order.length}`;
  }
  for (let i = 0; i < order.length; i++) {
    const rec = chain.assets[i];
    if (!rec || typeof rec !== 'object') return `asset #${i} is not a record`;
    if (rec.hash !== order[i]) return `asset #${i} is out of first-appearance order`;
    if (rec.tokenId !== i + 1) return `asset #${i} has tokenId ${String(rec.tokenId)}, expected ${i + 1}`;
    if (rec.mintedIn !== firstSeen.get(order[i]!)) {
      return `asset ${order[i]} claims mintedIn ${String(rec.mintedIn)} but first appears in block #${String(firstSeen.get(order[i]!))}`;
    }
  }
  return null;
}
```

In `verifyChain`, after the per-block loop, fold the result into `ok`:

```ts
  const registry = registryProblem(chain);
  return { ok: blocks.every((b) => b.ok) && registry === null, blocks };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/chain/verify.test.ts` — Expected: PASS.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 5: Create the assets directory**

```bash
mkdir -p content/assets
touch content/assets/.gitkeep
```

Git does not track empty directories, and the build reads this path.

- [ ] **Step 6: Re-mine the real chain**

```bash
rm chain.lock.json
npm run chain:build -- --now=2026-08-02
```

Expected: two blocks at difficulty 5, `integrity   OK`, `assets      0` — your genesis post references no images.

Confirm idempotence: run it again and check `git diff --stat chain.lock.json` reports no change.

- [ ] **Step 7: Prove the whole point end to end**

This is the claim the addendum exists to support, so verify it by hand rather than trusting the unit tests:

```bash
mkdir -p /tmp/asset-proof && cd /home/lamter/Projects/blogchain
npx tsx -e "$(cat <<'EOF'
import { writeFileSync, mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChain } from './src/chain/build';
import { verifyChain } from './src/chain/verify';
const CONFIG = { difficulty: 2, maxTxPerBlock: 4, authorHandle: 'lamter', authorName: 'lamter.eth' };
(async () => {
  const d = mkdtempSync(join(tmpdir(), 'proof-'));
  const postsDir = join(d, 'posts'), assetsDir = join(d, 'assets');
  mkdirSync(postsDir); mkdirSync(assetsDir);
  writeFileSync(join(assetsDir, 'fig.svg'), '<svg>ORIGINAL</svg>');
  writeFileSync(join(postsDir, '2026-06-01-p.md'),
    '---\ntitle: "Có hình"\ndate: 2026-06-01\ntags: [cp]\n---\n\n![f](/assets/fig.svg)\n');
  const lockPath = join(d, 'chain.lock.json');
  const built = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-08-10', config: CONFIG });
  console.log('built, verifies:', (await verifyChain(built.chain)).ok, '| token:', built.chain.assets[0]);
  // Swap the image on disk WITHOUT touching the post, then re-derive the tx hash.
  writeFileSync(join(assetsDir, 'fig.svg'), '<svg>TAMPERED</svg>');
  const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
  console.log('after image swap — amendments:', after.amendments,
              '| assets:', after.chain.assets.length);
})();
EOF
)"
```

Expected: the first build verifies and mints token 1; swapping the image alone produces **1 amendment** and a second asset record. If swapping the image produces zero amendments, the `assets:` line is not reaching the transaction hash and the feature does not work — stop and investigate.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test` and `npm run typecheck` — both clean.

```bash
git add src/chain/verify.ts tests/chain/verify.test.ts content/assets/.gitkeep chain.lock.json
git commit -m "feat(chain): verify the asset registry, add content/assets

The registry is derived data outside the mined header, so it gets its own
check: every referenced hash has one entry, every entry is referenced, mint
blocks match first appearance, and token ids run in that order."
```

---

## Done criteria

- `npm test` and `npm run typecheck` both pass.
- Canonical forms read `post/1`, `amendment/1`, `block/1`, `addr/1`.
- Building twice at the same clock leaves `chain.lock.json` byte-identical.
- A post referencing a missing asset fails the build, naming the file.
- Swapping a referenced image with no change to the post emits exactly one amendment.
- An unreferenced file in `content/assets/` never reaches the chain.
- Token ids are stable across rebuilds and are never reassigned.
- `verifyChain` rejects a registry inconsistent with the transactions, and does not throw on a malformed one.

## What this plan deliberately does not cover

The site. `/assets` and `/asset/[tokenId]` are Plan 2, which consumes the registry this addendum produces. Also out: image optimization, thumbnails, and git-lfs — all worth revisiting only if asset weight becomes a real problem.
