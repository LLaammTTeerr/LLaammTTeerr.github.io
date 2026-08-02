import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxRepo, buildSandbox } from './sandbox';
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
