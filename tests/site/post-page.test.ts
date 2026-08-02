import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDist } from './dist';
import { getBlocks, getPosts } from '../../src/site/chain-data';
import { PREFS_INLINE_SCRIPT } from '../../src/site/prefs-script';
import { buildSandbox, chainBuildSandbox, sandboxRepo } from './sandbox';

const slug = () => getPosts()[0]!.slug!;
const page = () => readDist(`tx/${slug()}/index.html`);

describe('post page', () => {
  it('exists for every post on the chain', () => {
    for (const tx of getPosts()) {
      expect(() => readDist(`tx/${tx.slug}/index.html`)).not.toThrow();
    }
  });

  it('shows the transaction panel with the committed hash', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(tx.hash);
    // Anchored to the panel's own head markup, not a bare substring: the
    // nav's "Transactions" link (present on every page via Base.astro)
    // would otherwise satisfy a bare toContain('Transaction') even if
    // TxPanel rendered nothing at all.
    expect(page()).toContain('<span class="lbl">Transaction</span>');
  });

  it('names the block the post was sealed in', () => {
    // Derived from the chain, not hard-coded, and anchored to the exact
    // link markup TxPanel renders — a bare /Block/ regex would (and did)
    // pass on any page, since Base.astro's nav renders a "Blocks" link
    // regardless of whether TxPanel names a block at all.
    const tx = getPosts()[0]!;
    const block = getBlocks().find((b) => b.transactions.some((t) => t.hash === tx.hash))!;
    expect(page()).toContain(`<a href="/block/${block.height}">#${block.height}</a>`);
  });

  it('renders the post title as the page h1', () => {
    const tx = getPosts()[0]!;
    expect(page()).toMatch(new RegExp(`<h1[^>]*>${tx.title}</h1>`));
  });

  it('renders the body as HTML, not as raw markdown', () => {
    expect(page()).toContain('<p>');
    expect(page()).not.toContain('---\ntitle:');
  });

  it('shows gas and value from the committed transaction', () => {
    // Anchored to the panel's own <span class="num"> markup. A bare
    // toContain(String(tx.gasUsed)) passed even with TxPanel's gas/value
    // spans deleted entirely: the same digits are echoed in the page's
    // <meta description> (built from tx.gasUsed independently) and can
    // also coincide with digits inside the tx hash printed just above.
    const tx = getPosts()[0]!;
    expect(page()).toContain(`<span class="num">${tx.gasUsed}</span>`);
    expect(page()).toContain(`<span class="num">${tx.value.toFixed(1)}</span>`);
  });

  it('links to each tag address the post sent to', () => {
    const tx = getPosts()[0]!;
    for (const tag of tx.tags) expect(page()).toContain(`/address/${tag}.tag`);
  });

  it('keeps the panel labels in English and the prose in Vietnamese', () => {
    expect(page()).toContain('Gas used');
    expect(page()).toContain('Khối đầu tiên');
  });

  it('runs the blocking preferences script before its first stylesheet', () => {
    // This replaces `expect(page()).toContain('data-palette')`, which was
    // vacuous: the only `data-palette` in a served page is inside Base.astro's
    // inline script, which every page carries whether or not it renders a
    // TxPanel — `dist/index.html` matches it too — and the served
    // `<html lang="vi">` tag has no such attribute at all, since the script
    // writes it at runtime. It could not fail for any reason to do with this
    // page.
    //
    // What the post page actually has to do is what prefs.test.ts pins for the
    // homepage: carry that script, in the head, ahead of any stylesheet, so
    // the reader's palette is set before first paint and there is no flash.
    const html = page();
    const script = html.indexOf(PREFS_INLINE_SCRIPT);
    expect(script, 'the post page does not carry the preferences script').toBeGreaterThan(-1);
    const firstStylesheet = html.indexOf('<link rel="stylesheet"');
    expect(firstStylesheet, 'the post page links no stylesheet at all').toBeGreaterThan(-1);
    expect(script).toBeLessThan(firstStylesheet);
    expect(script).toBeLessThan(html.indexOf('<body'));
  });

  it('sets a per-post title and description', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(`<title>${tx.title}`);
  });
});

/**
 * A post published into the month that is still open.
 *
 * None of this can be asserted against the project's own `dist/`: the
 * committed chain is entirely sealed and no `chain.pending.json` is committed
 * (nor should one be — it exists only while something is unsealed). So these
 * drive a throwaway copy of the repository through a real `chain:build` and a
 * real `astro build`, and read that copy's `dist/`. The expectations come from
 * the `chain.pending.json` that build wrote, never from literals: a hard-coded
 * height or period would keep passing if the page stopped reading the chain.
 */
const PENDING_SLUG = '2026-08-10-bai-dang-chua-niem-phong';
const PENDING_TITLE = 'Bài đăng chưa niêm phong';
/** A sentence that appears nowhere else in the repository. */
const PENDING_BODY = 'Một đoạn văn chỉ có trong bài đang chờ niêm phong.';
const PENDING_PATH = join('content/posts', `${PENDING_SLUG}.md`);
const PENDING_FILE = [
  '---',
  `title: "${PENDING_TITLE}"`,
  'date: 2026-08-10',
  'tags: [meta]',
  'research: 0.5',
  '---',
  '',
  PENDING_BODY,
  '',
].join('\n');

interface PendingRecord {
  period: string;
  height: number;
  transactions: { hash: string; slug: string | null; type: string }[];
}

function pendingRecord(dir: string): PendingRecord {
  return JSON.parse(readFileSync(join(dir, 'chain.pending.json'), 'utf8')) as PendingRecord;
}

/**
 * A copy of the repository whose open block holds the fixture post.
 *
 * The chain's tip is 2026-07 (sealed), so a post dated 2026-08-10 built at a
 * mid-August clock neither seals (the month is not over) nor overflows the
 * block (1 of 4 slots) — it stays pending. That is checked, not assumed: if a
 * future change to the sealing rule sealed it instead, these tests would
 * otherwise quietly start asserting sealed behaviour under a pending name.
 *
 * The check is that the record names *this post*, rather than that the open
 * block holds exactly one transaction. The repository will one day carry a
 * pending block of its own — that is the whole point of committing
 * `chain.pending.json` — and the sandbox copies it, so a count would then be
 * measuring the author's unpublished work rather than this fixture.
 */
function pendingSandbox(): string {
  const dir = sandboxRepo();
  writeFileSync(join(dir, PENDING_PATH), PENDING_FILE);
  const chain = chainBuildSandbox(dir, '2026-08-20');
  if (chain.status !== 0) {
    throw new Error(`chain:build failed in the sandbox:\n${chain.output}`);
  }
  const recorded = pendingRecord(dir).transactions;
  if (!recorded.some((t) => t.type === 'post' && t.slug === PENDING_SLUG)) {
    throw new Error(`the fixture post did not land in the open block:\n${chain.output}`);
  }
  return dir;
}

describe('a post published into the open block', () => {
  let dir: string;
  let record: PendingRecord;
  let home: string;
  let sealed: string;

  beforeAll(() => {
    dir = pendingSandbox();
    const build = buildSandbox(dir);
    if (build.status !== 0) {
      throw new Error(`sandbox build failed:\n${build.output}`);
    }
    record = pendingRecord(dir);
    home = readFileSync(join(dir, 'dist/index.html'), 'utf8');
    sealed = readFileSync(join(dir, 'dist/tx', slug(), 'index.html'), 'utf8');
  }, 300_000);

  /** Read lazily, so the missing-page failure names the page and not the suite. */
  const pendingPage = (): string => {
    const path = join(dir, 'dist/tx', PENDING_SLUG, 'index.html');
    if (!existsSync(path)) {
      throw new Error(
        `${path} was not built — a post in the open block has no page, which is ` +
          `indistinguishable to a reader from a publishing failure`,
      );
    }
    return readFileSync(path, 'utf8');
  };

  const pendingTx = (): PendingRecord['transactions'][number] => {
    const tx = record.transactions.find((t) => t.type === 'post' && t.slug === PENDING_SLUG);
    if (tx === undefined) throw new Error('the open block records no post transaction');
    return tx;
  };

  it('has a page of its own at /tx/<slug>, with its title and body', () => {
    const html = pendingPage();
    expect(html).toMatch(new RegExp(`<h1[^>]*>${PENDING_TITLE}</h1>`));
    expect(html).toContain(PENDING_BODY);
  });

  it('stamps the transaction unsealed and marks its hash provisional', () => {
    const html = pendingPage();
    // Anchored to the panel's own markup: the nav's "Transactions" link is on
    // every page and would satisfy a bare toContain('Transaction').
    expect(html).toContain('<span class="lbl">Transaction</span>');
    expect(html).toContain('<span class="stamp open">Chưa niêm phong</span>');
    // The real hash the chain recorded, marked as not yet committed.
    expect(html).toContain(`<span class="tilde">~</span>${pendingTx().hash}`);
    expect(html, 'an unconfirmed transaction was stamped Sealed').not.toContain('Sealed');
  });

  it('resolves the Block field to the open block, not to an em dash', () => {
    // getBlocks() is sealed-only, so a pending transaction found its block
    // there as `undefined` and the field rendered `—`. Height and period are
    // read from the record the build wrote, not written down here.
    //
    // The link goes to `/blocks`, not to `/block/<height>`: the open block has
    // no page of its own, because its height is a prediction a size split can
    // still change (see the note in TxPanel.astro). That the field *names* the
    // predicted height is the point of this test; where it points is pinned in
    // tests/site/block-routes.test.ts, against a build that shows no such page
    // exists.
    expect(pendingPage()).toContain(
      `<dd><a href="/blocks">#${record.height}</a> · ${record.period} · đang mở</dd>`,
    );
  });

  it('leaves a sealed post in the same build stamped Sealed', () => {
    // The other half of the discrimination: a route that passed `pending`
    // unconditionally, or a panel that ignored it, would pass every test
    // above and fail here.
    const tx = getPosts()[0]!;
    const block = getBlocks().find((b) => b.transactions.some((t) => t.hash === tx.hash))!;
    expect(sealed).toContain('<span class="stamp">Sealed</span>');
    expect(sealed).toContain(`<dd><a href="/block/${block.height}">#${block.height}</a> · ${block.period}</dd>`);
    expect(sealed).not.toContain('Chưa niêm phong');
    expect(sealed).not.toContain('đang mở');
  });

  it('appears on the homepage as the newest block, above the sealed ones', () => {
    const order = [...home.matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order, 'the homepage rendered no blocks at all').not.toHaveLength(0);
    expect(order[0], 'the open block is not the first block on the homepage').toBe(record.height);
    expect(order).toEqual([...order].sort((a, b) => b - a));
    expect(home).toContain(`<a href="/tx/${PENDING_SLUG}">${PENDING_TITLE}</a>`);
  });

  it('still fails the build when it is edited without running chain:build', () => {
    // A pending post is not in `chain.lock.json`, but it *is* recorded in
    // `chain.pending.json` with a contentHash derived from the same file.
    // Skipping the re-derivation for pending posts would ship a body no
    // transaction vouches for, beside a hash that vouches for other text.
    const broken = pendingSandbox();
    const path = join(broken, PENDING_PATH);

    // Control. Without it this passes for any reason the sandbox fails to
    // build, and stops testing the guard without ever going red.
    const control = buildSandbox(broken);
    expect(control.status, `control build of the untouched copy failed:\n${control.output}`).toBe(0);
    expect(
      existsSync(join(broken, 'dist/tx', PENDING_SLUG, 'index.html')),
      'the control build produced no page for the pending post',
    ).toBe(true);

    writeFileSync(path, readFileSync(path, 'utf8') + '\nMột dòng chưa được ghi lại.\n');

    const build = buildSandbox(broken);
    expect(
      build.status,
      `the build shipped a pending body no transaction vouches for:\n${build.output}`,
    ).not.toBe(0);
    expect(build.output).toMatch(/does not match the chain/);
    expect(build.output).toContain(PENDING_PATH);
    // The remedy names what will actually happen. Editing a post that has not
    // sealed re-hashes its transaction; there is nothing committed yet for an
    // amendment to be evidence against (§3.6), so promising one would send the
    // author looking for a ledger entry that never appears.
    expect(build.output).toContain('re-run `npm run chain:build` to record the edit');
    expect(
      build.output,
      'the remedy promised an amendment, which an unsealed edit does not produce',
    ).not.toContain('as an amendment');
    expect(
      existsSync(join(broken, 'dist/tx', PENDING_SLUG, 'index.html')),
      'a page was emitted for a pending body the chain does not record',
    ).toBe(false);
  }, 300_000);
});
