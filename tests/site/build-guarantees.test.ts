import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxRepo, buildSandbox, chainBuildSandbox, pendingIdsIn } from './sandbox';
import { getPosts } from '../../src/site/chain-data';

/**
 * Guarantees that belong to the *build*, not to a function.
 *
 * `tests/site/content.test.ts` proves `getPostContent` refuses a drifted file,
 * and `tests/site/chain-data.test.ts` proves `researchHours` never formats an
 * undeclared value as a figure. Neither binds a page to either: replacing
 * `getPostContent(tx.slug!)` in `src/pages/tx/[slug].astro` with a bare
 * `readFileSync` of the post body — deleting the SHA-256 re-derivation
 * entirely — left all 412 unit tests green while the build shipped unverified
 * disk text beside a `contentHash` vouching for other text.
 *
 * These tests build a deliberately broken copy of the repository and assert on
 * what `astro build` did, so the wiring itself is what is under test.
 */

const SLUG = getPosts()[0]!.slug!;
const POST = join('content/posts', `${SLUG}.md`);

describe('the build refuses a post body that has drifted from the chain', () => {
  it('builds an untouched copy, then refuses the same copy with one character changed', () => {
    const dir = sandboxRepo();

    // Control. Without it this test would pass for any reason the sandbox
    // fails to build — a missing directory in `COPIED`, a broken symlink —
    // and would stop testing the drift guard without ever going red.
    const clean = buildSandbox(dir);
    expect(clean.status, `control build of an untouched copy failed:\n${clean.output}`).toBe(0);
    expect(
      existsSync(join(dir, 'dist/tx', SLUG, 'index.html')),
      'the control build produced no post page, so the drift build has nothing to refuse',
    ).toBe(true);

    // One character of the body, in the same shape as a typo fix to a sealed
    // post. `chuỗi này` occurs only in the body — `chuỗi` alone also appears
    // in the frontmatter `summary`, which is not hashed and would leave
    // `contentHash` unchanged.
    const path = join(dir, POST);
    const original = readFileSync(path, 'utf8');
    const drifted = original.replace('chuỗi này', 'chuoi này');
    expect(drifted, 'the drift edit changed nothing — the post body no longer contains the target text').not.toBe(original);
    writeFileSync(path, drifted);

    const build = buildSandbox(dir);
    expect(
      build.status,
      `the build shipped a post body the chain does not vouch for:\n${build.output}`,
    ).not.toBe(0);
    expect(build.output).toMatch(/does not match the chain/);
    expect(build.output).toContain(POST);
    expect(
      existsSync(join(dir, 'dist/tx', SLUG, 'index.html')),
      'a page was emitted for a drifted post',
    ).toBe(false);
  }, 120_000);
});

describe('the edit cycle a published post actually goes through', () => {
  /**
   * The whole loop, on a real chain: edit, record, build, and — the part that
   * used to be impossible — go back.
   *
   * Both halves of this were closed loops that no unit test could have caught,
   * because each needs `chain:build` and `astro build` to agree with each other
   * across a real ledger:
   *
   *  - the site compared the file against the *sealed* content hash, which an
   *    amendment by design cannot change, so any edit to a published post
   *    failed the build forever;
   *  - the engine deduped new amendments against *every* state it had ever
   *    recorded, so a revert to an earlier one was recorded nowhere, and the
   *    site — which renders the latest recorded state — refused it forever.
   *
   * Three states are the minimum that can tell "the latest recorded state"
   * from "any state ever recorded": with only v1 and v2 the revert target and
   * the current state are the same thing.
   */
  function bodyOf(dir: string): string {
    return readFileSync(join(dir, POST), 'utf8');
  }

  it('seals v1, amends to v2, amends to v3, then reverts to v2 and still builds', () => {
    const dir = sandboxRepo();
    const path = join(dir, POST);
    const v1 = bodyOf(dir);
    const v2 = v1 + '\nPhiên bản hai.\n';
    const v3 = v2 + 'Phiên bản ba.\n';

    // v2 — recorded in the open block, then sealed by the next month's build.
    writeFileSync(path, v2);
    const amendV2 = chainBuildSandbox(dir, '2026-08-05');
    expect(amendV2.status, `chain:build failed:\n${amendV2.output}`).toBe(0);
    // This post's own amendment, not a total — see pendingIdsIn. An amendment
    // is recorded under the hash it amends, which is the sealed post's.
    expect(pendingIdsIn(dir)).toContain(getPosts()[0]!.hash);
    expect(chainBuildSandbox(dir, '2026-09-05').status).toBe(0);

    // v3 — likewise, so both amendments are confirmed history.
    writeFileSync(path, v3);
    expect(chainBuildSandbox(dir, '2026-09-05').status).toBe(0);
    const sealV3 = chainBuildSandbox(dir, '2026-10-05');
    expect(sealV3.status, `chain:build failed:\n${sealV3.output}`).toBe(0);

    const atV3 = buildSandbox(dir);
    expect(atV3.status, `the build refused the state it had just recorded:\n${atV3.output}`).toBe(0);
    expect(readFileSync(join(dir, 'dist/tx', SLUG, 'index.html'), 'utf8')).toContain('Phiên bản ba.');

    // The revert. v2 is a state the chain has recorded before, but not the one
    // it records now — so it is a change, and `chain:build` must write it down.
    writeFileSync(path, v2);
    const revert = chainBuildSandbox(dir, '2026-10-05');
    expect(revert.status, `chain:build failed:\n${revert.output}`).toBe(0);
    expect(
      revert.output,
      'the revert was recorded nowhere, so the build below can never be unstuck',
    ).toMatch(/pending\s+\d+ txn/);

    const atV2 = buildSandbox(dir);
    expect(
      atV2.status,
      `the build refused a body chain:build had just recorded — the loop is back:\n${atV2.output}`,
    ).toBe(0);

    const page = readFileSync(join(dir, 'dist/tx', SLUG, 'index.html'), 'utf8');
    expect(page, 'the page did not show the reverted body').toContain('Phiên bản hai.');
    expect(
      page,
      'the page still shows the superseded body — the chain records v2 and the site rendered v3',
    ).not.toContain('Phiên bản ba.');
  }, 300_000);

  it('still refuses an edit made without running chain:build, mid-cycle', () => {
    // The guarantee, checked where it is easiest to lose: a chain that already
    // carries a pending amendment. Accepting anything that had ever been
    // recorded, or anything at all, would pass every test above and be
    // worthless.
    const dir = sandboxRepo();
    const path = join(dir, POST);
    writeFileSync(path, readFileSync(path, 'utf8') + '\nPhiên bản hai.\n');
    expect(chainBuildSandbox(dir, '2026-08-05').status).toBe(0);
    expect(buildSandbox(dir).status).toBe(0);

    // One more edit, and this time no `chain:build`.
    writeFileSync(path, readFileSync(path, 'utf8') + '\nChưa được ghi lại.\n');
    const build = buildSandbox(dir);
    expect(
      build.status,
      `the build shipped a body no transaction vouches for:\n${build.output}`,
    ).not.toBe(0);
    expect(build.output).toMatch(/does not match the chain/);
    expect(build.output).toContain(POST);
    expect(build.output).toMatch(/committed 0x[0-9a-f]{8}…, on disk 0x[0-9a-f]{8}…/);
    expect(
      existsSync(join(dir, 'dist/tx', SLUG, 'index.html')),
      'a page was emitted for a body the chain does not record',
    ).toBe(false);
  }, 300_000);
});

describe('a post that declares no research hours', () => {
  /**
   * §3.8: `research` is optional and "defaults to `0.0`, which displays as `—`
   * rather than a misleading `0`". The one post on the committed chain declares
   * `1.0`, so the sealed ledger cannot exercise the default — and the sealed
   * ledger must not be regenerated to make it. The sandbox's copy of
   * `chain.lock.json` is set to `value: 0`, which is exactly what the engine
   * commits for a post with no `research` key, and the real ledger is untouched.
   */
  it('renders an em dash on the post page and the block card, never 0.0', () => {
    const dir = sandboxRepo();
    const lockPath = join(dir, 'chain.lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      blocks: { transactions: { value: number }[] }[];
    };
    for (const block of lock.blocks) {
      for (const tx of block.transactions) tx.value = 0;
    }
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

    // The open block, when the repository has one, is rendered on the homepage
    // beside the sealed cards, and its transactions come from a second file the
    // loop above never touches. Zeroing only the lock would leave a genuinely
    // declared figure on the page and fail the assertion below for a reason
    // that has nothing to do with the em dash.
    const pendingPath = join(dir, 'chain.pending.json');
    if (existsSync(pendingPath)) {
      const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as {
        transactions: { value: number }[];
      };
      for (const tx of pending.transactions) tx.value = 0;
      writeFileSync(pendingPath, JSON.stringify(pending, null, 2) + '\n');
    }

    const build = buildSandbox(dir);
    expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);

    const post = readFileSync(join(dir, 'dist/tx', SLUG, 'index.html'), 'utf8');
    expect(post).toContain('<dt>Value</dt><dd>—</dd>');
    expect(
      post,
      'the post page printed a research figure the author never declared',
    ).not.toMatch(/[\d.]+\s*<\/span>\s*giờ nghiên cứu/);

    const home = readFileSync(join(dir, 'dist/index.html'), 'utf8');
    expect(home).toMatch(/<span class="g">\d+ từ · —<\/span>/);
    expect(
      home,
      'the block card printed a research figure the author never declared',
    ).not.toMatch(/\d+\.\d+ giờ/);
  }, 120_000);
});
