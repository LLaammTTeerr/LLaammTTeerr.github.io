import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSandbox, chainBuildSandbox, sandboxRepo } from './sandbox';
import { sha256Hex } from '../../src/chain/hash';
import type { AssetRecord } from '../../src/chain/types';

/**
 * §3.2b — a referenced image whose bytes disagree with the chain fails the
 * build, exactly as a drifted body does.
 *
 * The asymmetry this closes. `tests/site/build-guarantees.test.ts` pins that an
 * unrecorded edit to a post's *text* fails the build, names the file, prints
 * both hashes and gives the remedy. An unrecorded swap of a post's *image* used
 * to exit 0: `src/site/asset-files.ts` correctly declined to publish bytes the
 * chain does not vouch for, so the page shipped with
 * `<img src="/assets/so-do.svg">` and nothing at that path. Same fact — the
 * bytes on disk disagree with what the chain committed — and the quieter
 * failure was the worse one: the build said everything was fine, the post
 * shipped, and a reader found a broken diagram where a figure should be.
 *
 * Driven through a real `chain:build` and a real `astro build`, because the
 * guarantee is about what the *build* does. A unit test of `getPostContent`
 * cannot see a route that stops calling it.
 *
 * The boundaries this must not cross, and which are pinned below: a file that
 * is *gone* is reported as gone, because no rerun of `chain:build` can record
 * bytes that no longer exist; a *recorded* swap still succeeds and serves the
 * new bytes, or the check would be satisfied by refusing every swap; and a file
 * no *current* transaction commits to is not drift at all.
 */

const V1 = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n';
const V2 = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>\n';
const OTHER = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>\n';
/** Bytes no fixture ever commits, for the case where two files must both drift. */
const THIRD = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h32v32z"/></svg>\n';
const FILE = 'so-do.svg';
const SECOND = 'bang.svg';

const SLUG = '2026-08-02-so-do';
const post = (...images: string[]): string =>
  [
    '---',
    'title: "Sơ đồ khối"',
    'date: 2026-08-02',
    'tags: [meta]',
    'research: 2.0',
    '---',
    '',
    'Một bài viết có hình.',
    '',
    ...images.map((f) => `![Hình](/assets/${f})\n`),
  ].join('\n');

/** The page the drift must keep out of the build. */
const PAGE = join('dist/tx', SLUG, 'index.html');

describe('an image the chain has not recorded', () => {
  let dir = '';

  beforeAll(() => {
    // `'fixture'`: the registry has to start empty for "the token this post
    // minted" to be `registry()[0]` and for the recorded swap to bring the
    // count to two. §3.2b assigns token ids from 1 by first appearance, so
    // copying the repository's own registry makes both of those assertions
    // about how many diagrams the author has already published.
    dir = sandboxRepo({ content: 'fixture' });
    mkdirSync(join(dir, 'content/assets'), { recursive: true });
    writeFileSync(join(dir, 'content/assets', FILE), V1);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), post(FILE));
    // 2026-08 opens with the post; 2026-09 seals it and mints the token.
    for (const now of ['2026-08-05', '2026-09-05']) {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
    }
    // Control. Without it every assertion below would pass for any reason the
    // sandbox fails to build, and would stop testing drift without going red.
    const clean = buildSandbox(dir);
    if (clean.status !== 0) throw new Error(`control build failed:\n${clean.output}`);
    if (!existsSync(join(dir, PAGE))) throw new Error('the control build produced no post page');
  }, 600_000);

  function registry(): AssetRecord[] {
    return (
      JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as { assets: AssetRecord[] }
    ).assets;
  }

  it('fails the build, names the file, prints both hashes and the remedy', async () => {
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    try {
      const build = buildSandbox(dir);
      expect(
        build.status,
        `the build shipped a post whose image the chain does not vouch for:\n${build.output}`,
      ).not.toBe(0);

      expect(build.output).toMatch(/does not match the chain/);
      expect(build.output).toContain(join('content/assets', FILE));
      // The committed hash is the token's, the on-disk hash is what replaced
      // it — both truncated exactly as the body message truncates.
      expect(build.output).toContain(`committed ${registry()[0]!.hash.slice(0, 10)}…`);
      expect(build.output).toContain(`on disk ${(await sha256Hex(V2)).slice(0, 10)}…`);
      expect(build.output).toContain(
        're-run `npm run chain:build` to record the edit as an amendment',
      );
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 300_000);

  it('emits no page for the post, rather than one with a broken image', () => {
    // The point of failing at all. A page that shipped with a dead `<img src>`
    // is the outcome this replaces, so the page must be absent — not merely
    // accompanied by an error on stderr.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    try {
      expect(buildSandbox(dir).status).not.toBe(0);
      expect(existsSync(join(dir, PAGE)), 'a page was emitted for a post with an unrecorded image').toBe(false);
      expect(
        existsSync(join(dir, 'dist/assets', FILE)),
        'the unrecorded bytes were published anyway',
      ).toBe(false);
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 300_000);

  it('is recognisably the same failure as an unrecorded body edit', () => {
    // `build-guarantees.test.ts` pins the body message against
    // `/does not match the chain/` and
    // `/committed 0x[0-9a-f]{8}…, on disk 0x[0-9a-f]{8}…/`. The image message
    // has to satisfy the same two patterns, or a reader who has met one will
    // not recognise the other.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    try {
      const image = buildSandbox(dir);
      expect(image.status).not.toBe(0);
      expect(image.output).toMatch(/does not match the chain/);
      expect(image.output).toMatch(/committed 0x[0-9a-f]{8}…, on disk 0x[0-9a-f]{8}…/);
      expect(image.output).toMatch(/re-run `npm run chain:build` to record the edit/);
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }

    // And the body failure, from the same sandbox, so the two are compared as
    // this build actually emits them rather than against a remembered shape.
    const path = join(dir, 'content/posts', `${SLUG}.md`);
    const original = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, original.replace('Một bài viết có hình.', 'Một bài viết có ảnh.'));
      const body = buildSandbox(dir);
      expect(body.status).not.toBe(0);
      expect(body.output).toMatch(/does not match the chain/);
      expect(body.output).toMatch(/committed 0x[0-9a-f]{8}…, on disk 0x[0-9a-f]{8}…/);
      expect(body.output).toMatch(/re-run `npm run chain:build` to record the edit/);
    } finally {
      writeFileSync(path, original);
    }
  }, 600_000);

  it('says a deleted file is deleted, not that it mismatches', () => {
    // The remedy differs and the author needs to know which they are in: no
    // rerun of `chain:build` can record bytes that are gone. Reporting a hash
    // mismatch against nothing would send them to the wrong command.
    rmSync(join(dir, 'content/assets', FILE));
    try {
      const build = buildSandbox(dir);
      expect(build.status).not.toBe(0);
      expect(build.output).toContain(`${join('content/assets', FILE)} not found`);
      expect(build.output).toContain(`"${SLUG}" references /assets/${FILE}`);
      expect(build.output).toContain('restore the file, or remove the reference from the post');
      expect(
        build.output,
        'a missing file was reported as a hash mismatch against nothing',
      ).not.toMatch(/does not match the chain/);
      expect(existsSync(join(dir, PAGE))).toBe(false);
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 300_000);

  it('builds and serves the new bytes once the swap is recorded', async () => {
    // The half that keeps this from being satisfied by refusing every swap.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    try {
      for (const now of ['2026-09-05', '2026-10-05']) {
        const built = chainBuildSandbox(dir, now);
        expect(built.status, `chain:build at ${now} failed:\n${built.output}`).toBe(0);
      }
      const build = buildSandbox(dir);
      expect(build.status, `the build refused a swap it had just recorded:\n${build.output}`).toBe(0);
      expect(existsSync(join(dir, PAGE))).toBe(true);
      expect(
        await sha256Hex(new Uint8Array(readFileSync(join(dir, 'dist/assets', FILE)))),
        'the recorded new bytes were not served',
      ).toBe(await sha256Hex(V2));
      expect(registry(), 'the swap minted no second token').toHaveLength(2);
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 600_000);

  it('does not fail on a file no current transaction commits to', () => {
    // The other boundary. A file nobody references is "just a file" (§3.2b),
    // and after the swap above the sealed registry still holds token #1 whose
    // bytes no current transaction names. Neither is drift, and a build that
    // failed on either would make the assets directory unusable as a place to
    // keep anything.
    //
    // Run at the state the swap left: token #1 is superseded, token #2 is
    // current, and V1's bytes now sit under a name nothing references.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    writeFileSync(join(dir, 'content/assets', 'so-do-cu.svg'), V1);
    writeFileSync(join(dir, 'content/assets', 'khong-ai-dung.svg'), OTHER);
    try {
      const build = buildSandbox(dir);
      expect(build.status, `an unreferenced file failed the build:\n${build.output}`).toBe(0);
      expect(
        existsSync(join(dir, 'dist/assets', 'khong-ai-dung.svg')),
        'a file on the chain nowhere was published',
      ).toBe(false);
    } finally {
      rmSync(join(dir, 'content/assets', 'so-do-cu.svg'));
      rmSync(join(dir, 'content/assets', 'khong-ai-dung.svg'));
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 300_000);
});

describe('an image on a post still in the open block', () => {
  /**
   * The remedy names a different *event* here. An edit to a sealed post is
   * recorded as an amendment (§3.9); an edit to one still in the open block
   * simply re-hashes its transaction, because nothing is committed yet for an
   * amendment to be evidence against (§3.6). Promising a ledger entry that
   * will not appear sends the author looking for it.
   *
   * The distinction is `getPostContent`'s, and the asset message shares it —
   * so it has to be checked on the asset path too, or a refactor that
   * hard-coded "as an amendment" would go unnoticed.
   */
  it('says "record the edit", not "as an amendment"', () => {
    const dir = sandboxRepo({ content: 'fixture' });
    mkdirSync(join(dir, 'content/assets'), { recursive: true });
    writeFileSync(join(dir, 'content/assets', FILE), V1);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), post(FILE));

    // One `chain:build` only, so the post sits in the open block unsealed.
    const chain = chainBuildSandbox(dir, '2026-08-05');
    expect(chain.status, `chain:build failed:\n${chain.output}`).toBe(0);
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      assets: AssetRecord[];
    };
    expect(lock.assets, 'the fixture sealed the post — the pending case is not exercised').toEqual([]);
    const clean = buildSandbox(dir);
    expect(clean.status, `control build failed:\n${clean.output}`).toBe(0);

    writeFileSync(join(dir, 'content/assets', FILE), V2);
    const build = buildSandbox(dir);
    expect(build.status).not.toBe(0);
    expect(build.output).toMatch(/does not match the chain/);
    expect(build.output).toContain('re-run `npm run chain:build` to record the edit');
    expect(
      build.output,
      'an unsealed post was promised an amendment the chain will not record',
    ).not.toContain('record the edit as an amendment');
  }, 600_000);
});

describe('a post referencing more than one image', () => {
  let dir = '';

  beforeAll(() => {
    dir = sandboxRepo({ content: 'fixture' });
    mkdirSync(join(dir, 'content/assets'), { recursive: true });
    writeFileSync(join(dir, 'content/assets', FILE), V1);
    writeFileSync(join(dir, 'content/assets', SECOND), OTHER);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), post(FILE, SECOND));
    for (const now of ['2026-08-05', '2026-09-05']) {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
    }
    const clean = buildSandbox(dir);
    if (clean.status !== 0) throw new Error(`control build failed:\n${clean.output}`);
  }, 600_000);

  it('mints a token per file, so the ambiguous case is real', () => {
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      assets: AssetRecord[];
    };
    expect(lock.assets.map((a) => a.file).sort()).toEqual([SECOND, FILE].sort());
    expect(lock.assets.map((a) => a.tokenId).sort(), 'ids are assigned from 1').toEqual([1, 2]);
  });

  it('names one file but no committed hash when several changed at once', () => {
    // `assets` is sorted so declaration order cannot move the transaction hash
    // (§3.2b), and the chain records no filename any hash covers. With two
    // files changed there are two unaccounted hashes and no way to say which
    // was which — so the message must not guess. It still names a real file
    // and a real on-disk hash.
    // Both files must hold bytes the chain commits to *nowhere*. Putting V1
    // into `bang.svg` would not do it: V1 is `so-do.svg`'s committed hash, the
    // multiset match would consume it, and only one file would be left drifted
    // — which is the *unambiguous* case, and this test would silently stop
    // exercising what it names.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    writeFileSync(join(dir, 'content/assets', SECOND), THIRD);
    try {
      const build = buildSandbox(dir);
      expect(build.status).not.toBe(0);
      expect(build.output).toMatch(/does not match the chain/);
      expect(build.output).toMatch(/on disk 0x[0-9a-f]{8}…/);
      expect(build.output).toContain('which is none of the 2 asset hashes');
      expect(build.output).toContain(`"${SLUG}" commits to`);
      expect(
        build.output,
        'the message paired a file with a committed hash it cannot know',
      ).not.toMatch(/committed 0x[0-9a-f]{8}…/);
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
      writeFileSync(join(dir, 'content/assets', SECOND), OTHER);
    }
  }, 300_000);

  it('pairs the hashes when only one of the two changed', () => {
    // One drifted file leaves exactly one committed hash unaccounted for, so
    // the pair is knowable and the message is the body message's sibling again.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    try {
      const build = buildSandbox(dir);
      expect(build.status).not.toBe(0);
      expect(build.output).toContain(join('content/assets', FILE));
      expect(build.output).toMatch(/committed 0x[0-9a-f]{8}…, on disk 0x[0-9a-f]{8}…/);
      expect(build.output).not.toContain('which is none of the');
    } finally {
      writeFileSync(join(dir, 'content/assets', FILE), V1);
    }
  }, 300_000);

  it('accepts two referenced files holding identical bytes', () => {
    // `assets` is a sorted multiset, not a set: two files with the same bytes
    // record the same hash twice. A check that consumed a `Set` would match the
    // first file and then report the second as drifted, failing a build that is
    // entirely correct.
    writeFileSync(join(dir, 'content/assets', SECOND), V1);
    try {
      const recorded = chainBuildSandbox(dir, '2026-10-05');
      expect(recorded.status, `chain:build failed:\n${recorded.output}`).toBe(0);
      const build = buildSandbox(dir);
      expect(
        build.status,
        `two referenced files with identical bytes failed the build:\n${build.output}`,
      ).toBe(0);
      expect(existsSync(join(dir, PAGE))).toBe(true);
      // Both names are served, from the one committed byte-stream.
      expect(readFileSync(join(dir, 'dist/assets', FILE), 'utf8')).toBe(V1);
      expect(readFileSync(join(dir, 'dist/assets', SECOND), 'utf8')).toBe(V1);
    } finally {
      writeFileSync(join(dir, 'content/assets', SECOND), OTHER);
    }
  }, 600_000);
});
