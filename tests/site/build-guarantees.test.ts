import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxRepo, buildSandbox, chainBuildSandbox, pendingIdsIn } from './sandbox';
import { canonicalRecordedTx, normalizeBody, wordCount } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';
import { parsePost } from '../../src/chain/post';
import type { Transaction } from '../../src/chain/types';
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

describe("an amended post's page describes the amendment, not the original", () => {
  /**
   * The Critical this branch shipped: `/tx/<slug>` rendered the amendment's
   * *body* underneath the original transaction's hash, title, tags, gas and
   * value, stamped `Sealed`, with no notice anywhere that the post had been
   * amended. The hash printed beside the text did not commit to it — which is
   * the one thing this whole project claims (§3.2, §7).
   *
   * Nothing in the suite caught it because nothing compared a *rendered* field
   * against the chain's *latest* record. So this drives a real edit through a
   * real `chain:build` and a real `astro build`, then recomputes the shown
   * hash from the shown transaction's own fields and checks that its `body:`
   * line is the sha256 of the body on the page.
   */
  const NEW_TITLE = 'Khối đầu tiên (đã sửa)';
  const NEW_SENTENCE = 'Một câu bổ sung hoàn toàn mới.';

  /** Applies the edit an author would make: title, tags, research, body. */
  function amend(dir: string): void {
    const path = join(dir, POST);
    const original = readFileSync(path, 'utf8');
    const edited =
      original
        .replace('title: "Khối đầu tiên"', `title: "${NEW_TITLE}"`)
        .replace('tags: [meta]', 'tags: [meta, chain]')
        .replace('research: 1.0', 'research: 9.5')
        .replace(/\n*$/, '\n') + `\n${NEW_SENTENCE}\n`;
    expect(edited, 'the fixture post no longer has the frontmatter this edit targets').not.toBe(original);
    writeFileSync(path, edited);
  }

  function panelOf(html: string): string {
    const panel = /<div class="txpanel">[\s\S]*?<article class="post">/.exec(html);
    expect(panel, 'the page rendered no transaction panel at all').not.toBeNull();
    return panel![0];
  }

  it('prints a hash that commits to the text beside it, with the amended metadata', async () => {
    const dir = sandboxRepo();
    const sealedHash = getPosts()[0]!.hash;
    amend(dir);

    const record = chainBuildSandbox(dir, '2026-08-05');
    expect(record.status, `chain:build failed:\n${record.output}`).toBe(0);
    expect(pendingIdsIn(dir), 'the edit produced no amendment').toContain(sealedHash);

    const build = buildSandbox(dir);
    expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
    const html = readFileSync(join(dir, 'dist/tx', SLUG, 'index.html'), 'utf8');
    const panel = panelOf(html);

    // The recorded amendment, and the hash the panel actually printed.
    const pending = JSON.parse(readFileSync(join(dir, 'chain.pending.json'), 'utf8')) as {
      transactions: Transaction[];
    };
    const shown = /class="a-hash"><span class="tilde">~<\/span>(0x[0-9a-f]{64})</.exec(panel);
    expect(shown, 'the panel printed no unconfirmed transaction hash').not.toBeNull();
    const hash = shown![1]!;
    expect(hash, 'the panel printed the superseded original as this page\'s transaction').not.toBe(sealedHash);

    const tx = pending.transactions.find((t) => t.hash === hash);
    expect(tx, 'the hash on the page is in no record the build wrote').toBeDefined();

    // The whole point. Recompute the printed hash from the printed
    // transaction's own fields, and check the body it commits to is the body
    // rendered underneath it.
    const canonical = canonicalRecordedTx(tx!);
    expect(canonical, 'the shown transaction cannot be canonicalized').not.toBeNull();
    expect(await sha256Hex(canonical!), 'the printed hash is not the hash of its own fields').toBe(hash);
    const body = normalizeBody(parsePost(join(dir, POST), readFileSync(join(dir, POST), 'utf8')).body);
    expect(canonical!.split('\n').at(-1), 'the printed hash commits to other text than the page shows')
      .toBe(`body:${await sha256Hex(body)}`);

    // Every field the review found lying, checked against that same record.
    expect(html).toContain(`>${NEW_TITLE}</h1>`);
    expect(html).toContain(`<title>${NEW_TITLE}`);
    expect(html, 'the page is still headed by the superseded title').not.toMatch(
      /<h1[^>]*>Khối đầu tiên<\/h1>/,
    );
    expect(panel).toContain('chain.tag');
    expect(html).toContain('#meta #chain');
    // §3.8 — gas is derived from the body, so it must be the count of the
    // words on this page, not the original transaction's stale figure.
    expect(panel).toContain(`<span class="num">${wordCount(body)}</span> từ`);
    expect(panel, 'gas is the superseded transaction\'s word count').not.toContain(
      `<span class="num">${getPosts()[0]!.gasUsed}</span> từ`,
    );
    // §3.9 — the declared hours live in `research`; `value` is 0 on purpose.
    expect(panel).toContain('<span class="num">9.5</span> giờ nghiên cứu');
    expect(panel, 'value came from the superseded transaction').not.toContain('<span class="num">1.0</span> giờ');
    // §3.6 — the amendment is in the open block, so nothing here is `Sealed`.
    expect(panel).toContain('Chưa niêm phong');
    expect(panel, 'an unsealed amendment was stamped Sealed').not.toContain('>Sealed<');
    // §3.9's notice, which must not name a block the amendment has not joined.
    expect(panel).toContain('Đã sửa');
    expect(panel, 'the notice named a predicted block height as a fact').not.toMatch(
      /Đã sửa trong khối <a href="\/block\/\d+">/,
    );
  }, 300_000);

  it('names the block once the amendment seals, and links it', () => {
    const dir = sandboxRepo();
    amend(dir);
    expect(chainBuildSandbox(dir, '2026-08-05').status).toBe(0);
    const seal = chainBuildSandbox(dir, '2026-09-05');
    expect(seal.status, `chain:build failed:\n${seal.output}`).toBe(0);

    const build = buildSandbox(dir);
    expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
    const panel = panelOf(readFileSync(join(dir, 'dist/tx', SLUG, 'index.html'), 'utf8'));

    // The height comes from the lock the build wrote, never from a literal.
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      blocks: { height: number; transactions: { type: string }[] }[];
    };
    const holder = lock.blocks.find((b) => b.transactions.some((t) => t.type === 'amendment'));
    expect(holder, 'no block on the chain holds the amendment').toBeDefined();

    // §3.9 — "The original post page then displays 'Amended in block #N',
    // linking to the amendment."
    expect(panel).toContain(
      `Đã sửa trong khối <a href="/block/${holder!.height}">#${holder!.height}</a>`,
    );
    expect(panel).toContain('<span class="stamp">Sealed</span>');
    // And the original is still reachable: it is what the block card for this
    // post shows, so the page must say which transaction it supersedes.
    expect(panel).toContain(`<dt>Amends</dt><dd><span class="hash">${getPosts()[0]!.hash}</span></dd>`);
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
