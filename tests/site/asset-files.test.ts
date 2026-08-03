import { beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { distPages, internalSrcs, resolvesIn } from './dist';
import { buildSandbox, chainBuildSandbox, sandboxRepo } from './sandbox';
import { sha256Hex } from '../../src/chain/hash';
import type { AssetRecord, Hex, Transaction } from '../../src/chain/types';
import {
  committedAssetHashes,
  committedAssetFiles,
  emitSiteAssets,
  writeCommittedAssets,
} from '../../src/site/asset-files';

/**
 * §3.2b — what `dist` may serve under `/assets/`.
 *
 * The defect this file exists to keep out: **nothing copied `content/assets/`
 * into `dist` at all**. A post embedding `![Sơ đồ](/assets/so-do.svg)` renders
 * `<img src="/assets/so-do.svg">`, which 404ed on every published image, and
 * 661 tests were green because every link check in the suite read `href` and
 * an image uses `src`.
 *
 * The rule the fix implements — `dist` serves exactly the bytes the chain
 * vouches for — has two halves, and only one of them is "the image appears":
 *
 *  - a file whose bytes hash into the sealed registry, or into a transaction
 *    in the open block (those posts have pages, and their images must work);
 *  - **nothing else.** A file no post references "is not on the chain at all;
 *    it is just a file" (§3.2b), and a file whose bytes no longer hash to any
 *    committed value is the superseded image the token page already refuses to
 *    show. Serving either under a path the chain does not vouch for is the same
 *    falsehood at a different surface.
 *
 * The live repository has no assets and will have none until the author
 * publishes an image, so every populated assertion below runs against a fixture
 * directory or a *sandbox copy* driven through a real `chain:build` and a real
 * `astro build`. An assertion over `content/assets/` as it ships would pass
 * vacuously forever.
 */

// Three files. V1 and V2 are the same name at two moments — the image swap.
// UNREFERENCED is the file that is just a file. All three differ in length, so
// bytes taken from the wrong one are visible.
const V1 = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n';
const V2 = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>\n';
const UNREFERENCED = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>\n';
const FILE = 'so-do.svg';
const SPARE = 'ghi-chu.svg';

function assetsDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'asset-files-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function record(over: Partial<AssetRecord> & { hash: Hex }): AssetRecord {
  return { tokenId: 1, file: FILE, mime: 'image/svg+xml', bytes: 0, mintedIn: 0, ...over };
}

function transaction(over: Partial<Transaction> & { hash: Hex }): Transaction {
  return {
    type: 'post',
    slug: 'bai-viet',
    title: 'Bài viết',
    date: '2026-08-02',
    tags: ['meta'],
    series: null,
    from: '0x' + '11'.repeat(20),
    to: [],
    contentHash: '0x' + '22'.repeat(32),
    assets: [],
    gasUsed: 10,
    value: 0,
    research: null,
    amends: null,
    ...over,
  };
}

describe('committedAssetHashes', () => {
  it('takes the sealed registry and the open block, and nothing else', async () => {
    const sealed = await sha256Hex(V1);
    const pending = await sha256Hex(V2);
    const stranger = await sha256Hex(UNREFERENCED);

    const hashes = committedAssetHashes(
      [record({ hash: sealed })],
      [transaction({ hash: '0xaa', assets: [pending] }), transaction({ hash: '0xbb', assets: [] })],
    );
    expect([...hashes].sort()).toEqual([sealed, pending].sort());
    expect(hashes.has(stranger)).toBe(false);
  });

  it('covers the open block, which has no registry record yet', async () => {
    // The registry is minted when a block SEALS (src/chain/build.ts), so a post
    // sitting in the open block has its asset hashes in `chain.pending.json`
    // and nowhere else. Reading only `getAssets()` would 404 every image on
    // every page of the current month — the state a working repository is in
    // most of the time.
    const hash = await sha256Hex(V1);
    expect(committedAssetHashes([], [transaction({ hash: '0xaa', assets: [hash] })]).has(hash)).toBe(true);
    expect(committedAssetHashes([], []).size).toBe(0);
  });
});

describe('committedAssetFiles', () => {
  it('selects a file whose bytes hash to a committed value', async () => {
    const dir = assetsDirWith({ [FILE]: V1 });
    const files = await committedAssetFiles(dir, new Set([await sha256Hex(V1)]));
    expect(files.map((f) => f.file)).toEqual([FILE]);
    expect(Buffer.from(files[0]!.bytes).toString('utf8')).toBe(V1);
  });

  it('leaves a file nothing references behind', async () => {
    // §3.2b: "A file no post references is not on the chain at all; it is just
    // a file." `.gitkeep` is the same case and ships in the repository today.
    const dir = assetsDirWith({ [FILE]: V1, [SPARE]: UNREFERENCED, '.gitkeep': '' });
    const files = await committedAssetFiles(dir, new Set([await sha256Hex(V1)]));
    expect(files.map((f) => f.file)).toEqual([FILE]);
  });

  it('leaves a superseded file behind — its bytes hash to nothing committed', async () => {
    // The file on disk is V2; the chain vouches for V1 and has not been
    // rebuilt. `/asset/1` already refuses to show these bytes beside token #1's
    // hash (src/site/assets-view.ts); serving them at `/assets/so-do.svg` would
    // publish exactly the image the token page declines to.
    const dir = assetsDirWith({ [FILE]: V2 });
    expect(await committedAssetFiles(dir, new Set([await sha256Hex(V1)]))).toEqual([]);
  });

  it('keys on bytes, never on the recorded filename', async () => {
    // `file` is covered by no hash anywhere on the chain (`registryProblem` in
    // src/chain/verify.ts says so outright), so it cannot decide what is
    // served. The name on disk is the name written out; the bytes decide
    // whether it is written at all.
    const dir = assetsDirWith({ 'ten-khac.svg': V1 });
    const files = await committedAssetFiles(dir, new Set([await sha256Hex(V1)]));
    expect(files.map((f) => f.file)).toEqual(['ten-khac.svg']);
  });

  it('is deterministic: the same directory always yields the same order', async () => {
    const dir = assetsDirWith({ 'b.svg': V1, 'a.svg': V2, 'c.svg': UNREFERENCED });
    const hashes = new Set([await sha256Hex(V1), await sha256Hex(V2), await sha256Hex(UNREFERENCED)]);
    const once = (await committedAssetFiles(dir, hashes)).map((f) => f.file);
    const twice = (await committedAssetFiles(dir, hashes)).map((f) => f.file);
    // Sorted, not readdir order: two consecutive builds must produce
    // byte-identical output, and readdir order is filesystem-dependent.
    expect(once).toEqual(['a.svg', 'b.svg', 'c.svg']);
    expect(twice).toEqual(once);
  });

  it('descends into no subdirectory and reads no directory as a file', async () => {
    // `/assets/<file>` has no slash in it (`referencedAssets` in
    // src/chain/asset.ts captures `[A-Za-z0-9._-]+`), so a nested file is
    // unreachable by any post and must not be flattened into the output.
    const dir = assetsDirWith({ [FILE]: V1 });
    mkdirSync(join(dir, 'ben-trong'));
    writeFileSync(join(dir, 'ben-trong', 'sau.svg'), V2);
    const files = await committedAssetFiles(dir, new Set([await sha256Hex(V1), await sha256Hex(V2)]));
    expect(files.map((f) => f.file)).toEqual([FILE]);
  });

  it('is empty, not an error, when the assets directory is absent', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'asset-files-')), 'khong-co');
    expect(await committedAssetFiles(dir, new Set([await sha256Hex(V1)]))).toEqual([]);
  });

  it('reads no clock', () => {
    // §14 — nothing under `src/site/` may read the clock.
    expect(readFileSync('src/site/asset-files.ts', 'utf8')).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});

describe('writeCommittedAssets', () => {
  it('writes the selected files and leaves an existing index.html alone', async () => {
    const src = assetsDirWith({ [FILE]: V1, [SPARE]: UNREFERENCED });
    const out = mkdtempSync(join(tmpdir(), 'asset-out-'));
    writeFileSync(join(out, 'index.html'), '<h1>Assets</h1>');

    const written = await writeCommittedAssets(src, out, new Set([await sha256Hex(V1)]));
    expect(written).toEqual([FILE]);
    expect(readdirSync(out).sort()).toEqual(['index.html', FILE].sort());
    expect(readFileSync(join(out, FILE), 'utf8')).toBe(V1);
    // The gallery page is a sibling of the files it lists; writing them must
    // not disturb it.
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('<h1>Assets</h1>');
  });

  it('creates the output directory when the build emitted no gallery there', async () => {
    const src = assetsDirWith({ [FILE]: V1 });
    const out = join(mkdtempSync(join(tmpdir(), 'asset-out-')), 'assets');
    expect(await writeCommittedAssets(src, out, new Set([await sha256Hex(V1)]))).toEqual([FILE]);
    expect(readFileSync(join(out, FILE), 'utf8')).toBe(V1);
  });

  it('refuses to overwrite a page the render already wrote there', async () => {
    // `![x](/assets/index.html)` is a legal reference — `referencedAssets`
    // accepts the name — and `dist/assets/index.html` is the gallery. Writing
    // the file there would replace the page listing every token with an asset,
    // silently. `astro build` clears the output directory first, so anything
    // already at the path is a route, not a leftover.
    const src = assetsDirWith({ 'index.html': V1 });
    const out = mkdtempSync(join(tmpdir(), 'asset-out-'));
    writeFileSync(join(out, 'index.html'), '<h1>Assets</h1>');
    await expect(writeCommittedAssets(src, out, new Set([await sha256Hex(V1)]))).rejects.toThrow(
      /would overwrite the built page/,
    );
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('<h1>Assets</h1>');
  });

  it('writes the very bytes it hashed', async () => {
    // Not a second read of the path. Between the hash and the copy the file
    // could change; writing back what was verified means the bytes in `dist`
    // are the bytes checked against the chain, by construction — the same
    // reasoning `assetEmbed` gives for building its `data:` uri from bytes it
    // hashed in the same call.
    const src = assetsDirWith({ [FILE]: V1 });
    const out = mkdtempSync(join(tmpdir(), 'asset-out-'));
    const files = await committedAssetFiles(src, new Set([await sha256Hex(V1)]));
    expect(await sha256Hex(files[0]!.bytes)).toBe(await sha256Hex(V1));
    await writeCommittedAssets(src, out, new Set([await sha256Hex(V1)]));
    expect(await sha256Hex(new Uint8Array(readFileSync(join(out, FILE))))).toBe(await sha256Hex(V1));
  });
});

describe('emitSiteAssets, against the live chain', () => {
  it('copies nothing, because the live registry is empty', async () => {
    // Pins the state this ships in. Deliberately not the evidence that the
    // copy works — it cannot fail while the chain has no assets, which is why
    // everything above and below is fixture- or sandbox-driven.
    const out = mkdtempSync(join(tmpdir(), 'asset-out-'));
    expect(await emitSiteAssets(out)).toEqual([]);
  });
});

/**
 * The whole workflow, on a real chain: an image, a post that references it, a
 * real `chain:build`, a real `astro build` — and then the two ways the build
 * must refuse to serve something.
 */
describe('a published image, end to end', () => {
  const SLUG = '2026-08-02-so-do';
  const POST = [
    '---',
    'title: "Sơ đồ khối"',
    'date: 2026-08-02',
    'tags: [meta]',
    'research: 2.0',
    '---',
    '',
    'Một bài viết có hình.',
    '',
    `![Sơ đồ](/assets/${FILE})`,
    '',
  ].join('\n');

  let dir = '';
  /** `dist` after the post's block sealed and the token was minted. */
  let sealedDist = '';

  beforeAll(() => {
    dir = sandboxRepo();
    mkdirSync(join(dir, 'content/assets'), { recursive: true });
    writeFileSync(join(dir, 'content/assets', FILE), V1);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), POST);

    // 2026-08 opens with the post in it; 2026-09 seals that month and mints
    // the token.
    for (const now of ['2026-08-05', '2026-09-05']) {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
    }
    const build = buildSandbox(dir);
    if (build.status !== 0) throw new Error(`sandbox build failed:\n${build.output}`);
    sealedDist = join(dir, 'dist');
  }, 600_000);

  /** The registry the sandbox's own build wrote — never a literal here. */
  function registry(): AssetRecord[] {
    return (
      JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as { assets: AssetRecord[] }
    ).assets;
  }

  it('mints the token, so this test is exercising the real path', () => {
    expect(registry().map((a) => a.file)).toEqual([FILE]);
  });

  it("serves the image at the path the post's <img src> names", () => {
    const page = readFileSync(join(sealedDist, 'tx', SLUG, 'index.html'), 'utf8');
    const srcs = internalSrcs(page);
    expect(srcs, 'the post page embedded no image at all — this checks nothing').toContain(
      `/assets/${FILE}`,
    );
    expect(
      resolvesIn(sealedDist, `/assets/${FILE}`),
      `the post embeds /assets/${FILE} and the build shipped no such file`,
    ).toBe(true);
  });

  it('serves the exact bytes the chain committed to', async () => {
    const onDisk = new Uint8Array(readFileSync(join(sealedDist, 'assets', FILE)));
    expect(await sha256Hex(onDisk)).toBe(registry()[0]!.hash);
  });

  it('resolves every src on every built page', () => {
    // The guarantee, over the whole site rather than the one page — and the
    // assertion that goes red when the copy is removed. `tests/site/nav.test.ts`
    // makes the same check against the live `dist`, where it is vacuous because
    // the author has published no image; here there is one.
    let checked = 0;
    for (const page of distPages(sealedDist)) {
      for (const src of internalSrcs(readFileSync(join(sealedDist, page), 'utf8'))) {
        checked++;
        expect(resolvesIn(sealedDist, src), `${src} is sourced by ${page} but is not in the build`).toBe(true);
      }
    }
    expect(checked, 'no built page sourced anything — the check is vacuous here too').toBeGreaterThan(0);
  });

  it('keeps the gallery page working beside the files it lists', () => {
    // `dist/assets/` now holds both `index.html` and the asset files. The
    // gallery must still be a page and must still be reachable as `/assets`.
    const gallery = readFileSync(join(sealedDist, 'assets/index.html'), 'utf8');
    expect(gallery).toContain('href="/asset/1"');
    expect(gallery).toContain(FILE);
    expect(resolvesIn(sealedDist, '/assets')).toBe(true);
    expect(distPages(sealedDist)).toContain('assets/index.html');
    expect(readdirSync(join(sealedDist, 'assets')).sort()).toEqual([FILE, 'index.html'].sort());
  });

  it('is byte-identical when the build is re-run', async () => {
    const before = readFileSync(join(sealedDist, 'assets', FILE));
    const again = buildSandbox(dir);
    expect(again.status, `the re-run build failed:\n${again.output}`).toBe(0);
    expect(readFileSync(join(sealedDist, 'assets', FILE)).equals(before)).toBe(true);
  }, 300_000);

  it('does not copy a file no post references', () => {
    // §3.2b. The author drops a file into `content/assets/` and nothing on the
    // chain names it; it must not become a url.
    writeFileSync(join(dir, 'content/assets', SPARE), UNREFERENCED);
    try {
      const build = buildSandbox(dir);
      expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
      expect(
        existsSync(join(sealedDist, 'assets', SPARE)),
        `${SPARE} is on the chain nowhere, and the build published it anyway`,
      ).toBe(false);
      // Control: the committed file is still there, so the assertion above is
      // about *this* file and not about the copy having stopped altogether.
      expect(existsSync(join(sealedDist, 'assets', FILE))).toBe(true);
    } finally {
      rmSync(join(dir, 'content/assets', SPARE));
    }
  }, 300_000);

  it('does not serve superseded bytes', async () => {
    // The image is swapped and `chain:build` is NOT re-run, so the chain still
    // vouches for V1 while the disk holds V2. Publishing V2 at
    // `/assets/so-do.svg` would put an image under a path the chain does not
    // vouch for — the falsehood `/asset/1` already refuses on the token page.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    try {
      const build = buildSandbox(dir);
      expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
      const path = join(sealedDist, 'assets', FILE);
      if (existsSync(path)) {
        const shipped = await sha256Hex(new Uint8Array(readFileSync(path)));
        expect(shipped, 'the build served bytes the chain does not vouch for').not.toBe(
          await sha256Hex(V2),
        );
      }
      expect(existsSync(path), 'the stale file survived from the previous build').toBe(false);
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 300_000);

  it('serves the new bytes once chain:build records the swap', async () => {
    // The other half: the refusal above is about an *unrecorded* swap, not
    // about the site being unable to publish a new image. Record it, and the
    // new bytes are served — under the same name, as the new token.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    try {
      for (const now of ['2026-09-05', '2026-10-05']) {
        const built = chainBuildSandbox(dir, now);
        expect(built.status, `chain:build at ${now} failed:\n${built.output}`).toBe(0);
      }
      const build = buildSandbox(dir);
      expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
      expect(registry()).toHaveLength(2);
      const shipped = new Uint8Array(readFileSync(join(sealedDist, 'assets', FILE)));
      expect(await sha256Hex(shipped)).toBe(await sha256Hex(V2));
      // Token #1's bytes are gone from disk and the chain stores hashes, not
      // bytes, so nothing under `/assets/` can be them.
      expect(await sha256Hex(shipped)).not.toBe(registry()[0]!.hash);
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 600_000);
});

describe('an asset that would overwrite a route', () => {
  /**
   * The unit test above proves `writeCommittedAssets` refuses; nothing in it
   * binds the *build* to that refusal. `astro build` must fail rather than
   * replace `/assets` — the page listing every token — with an image, so this
   * drives a real collision through a real build.
   */
  const SLUG = '2026-08-02-va-cham';
  const POST = [
    '---',
    'title: "Va chạm tên tệp"',
    'date: 2026-08-02',
    'tags: [meta]',
    '---',
    '',
    'Bài viết tham chiếu một tệp trùng tên trang.',
    '',
    '![Trùng](/assets/index.html)',
    '',
  ].join('\n');

  it('fails the build and leaves the gallery page intact', () => {
    const dir = sandboxRepo();
    mkdirSync(join(dir, 'content/assets'), { recursive: true });
    writeFileSync(join(dir, 'content/assets/index.html'), V1);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), POST);
    for (const now of ['2026-08-05', '2026-09-05']) {
      const built = chainBuildSandbox(dir, now);
      expect(built.status, `chain:build at ${now} failed:\n${built.output}`).toBe(0);
    }

    const build = buildSandbox(dir);
    expect(build.status, `the build replaced a route with an asset:\n${build.output}`).not.toBe(0);
    expect(build.output).toMatch(/would overwrite the built page/);
    expect(build.output).toContain('content/assets/index.html');

    const gallery = readFileSync(join(dir, 'dist/assets/index.html'), 'utf8');
    expect(gallery, 'the gallery page was clobbered before the build gave up').toContain('<!DOCTYPE html>');
  }, 600_000);
});

/**
 * The open block, which has no registry record at all. Separate sandbox: the
 * chain here must stay unsealed, and the suite above seals its month.
 */
describe('an image referenced only by a pending post', () => {
  const SLUG = '2026-08-02-nhap';
  const POST = [
    '---',
    'title: "Bài đang mở"',
    'date: 2026-08-02',
    'tags: [meta]',
    'research: 1.0',
    '---',
    '',
    'Bài viết trong khối đang mở.',
    '',
    `![Sơ đồ](/assets/${FILE})`,
    '',
  ].join('\n');

  it('serves the image while the block is still open', async () => {
    const dir = sandboxRepo();
    mkdirSync(join(dir, 'content/assets'), { recursive: true });
    writeFileSync(join(dir, 'content/assets', FILE), V1);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), POST);

    // One `chain:build` only: the post lands in the open block and no token is
    // minted, so the sealed registry says nothing about this file.
    const chain = chainBuildSandbox(dir, '2026-08-05');
    expect(chain.status, `chain:build failed:\n${chain.output}`).toBe(0);
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      assets: AssetRecord[];
    };
    expect(lock.assets, 'the fixture sealed a block — the pending case is not exercised').toEqual([]);
    expect(existsSync(join(dir, 'chain.pending.json')), 'nothing is pending').toBe(true);

    const build = buildSandbox(dir);
    expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);

    const distRoot = join(dir, 'dist');
    const page = readFileSync(join(distRoot, 'tx', SLUG, 'index.html'), 'utf8');
    expect(internalSrcs(page)).toContain(`/assets/${FILE}`);
    expect(
      resolvesIn(distRoot, `/assets/${FILE}`),
      'a pending post has a page, and its image 404ed',
    ).toBe(true);
    expect(await sha256Hex(new Uint8Array(readFileSync(join(distRoot, 'assets', FILE))))).toBe(
      await sha256Hex(V1),
    );
  }, 600_000);
});
