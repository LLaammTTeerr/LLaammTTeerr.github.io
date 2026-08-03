import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, internalHrefs, readDist, rendered, resolvesIn } from './dist';
import { buildSandbox, chainBuildSandbox, pendingIdsIn, sandboxRepo } from './sandbox';
import { getBlocks, getPendingBlock, getStats, resolvedPosts, shortHash } from '../../src/site/chain-data';
import type { RecordedTx } from '../../src/site/chain-data';

/**
 * `/tx` — the transaction index.
 *
 * The counterpart of `/blocks`: every transaction on the chain, newest first,
 * amendments included. Two properties carry most of this file, and both are
 * derived from the chain rather than written down:
 *
 *  - **one row per ledger transaction, in reverse chain order.** Asserted as an
 *    equality between the sequence of hashes the page prints and the sequence
 *    the ledger implies — which pins the count, the membership *and* the order
 *    in one statement. A count alone passes on a page that lists the right
 *    number of the wrong things;
 *  - **a post row shows the state the chain asserts now.** Read off the
 *    sandbox, where a post is sealed under one title and then amended, and
 *    stated as an equality with what `/tx/<slug>` itself prints — the surface
 *    that was already right.
 *
 * Nothing here asserts on nav chrome: the nav renders identically on every page
 * in the site, so `href="/tx"` in it is satisfied by `Base.astro` alone and says
 * nothing about whether this route exists. `tests/site/nav.test.ts` derives that
 * from `src/site/routes.ts` and checks the link resolves; what this file adds is
 * that `/tx` resolves to a page rather than to the bare `dist/tx/` directory the
 * post pages already create.
 */

const TX_INDEX = 'tx/index.html';

/** One of the page's two transaction lists, or `null` when it renders none. */
function listOf(html: string, which: 'open' | 'sealed'): string | null {
  const m = new RegExp(`<ul[^>]*data-tx-list="${which}"[^>]*>([\\s\\S]*?)</ul>`).exec(html);
  return m === null ? null : m[1]!;
}

/** The `<li>` rows of one list, in document order. */
function rowsIn(list: string): string[] {
  return [...list.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]);
}

/**
 * The hash a row *displays*, and whether it is marked unsealed.
 *
 * The first hash in the row, deliberately: an amendment row also names the
 * transaction it amends, and that reference must never be mistaken for the
 * row's own identity. `null` when the row prints no hash at all, which is a
 * failure this file reports rather than skips.
 */
const ROW_HASH =
  /<span class="a-hash"><span class="tilde">~<\/span>(0x[0-9a-f]{6}…[0-9a-f]{6})<\/span>|<span class="hash">(0x[0-9a-f]{6}…[0-9a-f]{6})<\/span>/;

function hashOf(row: string): { hash: string; pending: boolean } | null {
  const m = ROW_HASH.exec(row);
  if (m === null) return null;
  return m[1] === undefined ? { hash: m[2]!, pending: false } : { hash: m[1], pending: true };
}

/**
 * A page's own content, without the chrome `Base.astro` puts on every page.
 * The nav renders on every route, so a whole-document assertion says nothing
 * about this one.
 */
function mainOf(html: string): string {
  const m = /<main[^>]*>([\s\S]*)<\/main>/.exec(html);
  if (m === null) throw new Error('the page has no <main> element');
  return m[1]!;
}

/**
 * Rendered text, with markup removed — what a reader can select and paste.
 *
 * §3.2's display rule is about what is *shown*: `data-amends` carries the
 * committed hash the row names, exactly as `data-block` carries a height, and
 * an attribute is not a display. Asserting over raw markup would forbid the
 * attribute rather than the untruncated hash.
 */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** Every row the page prints, both lists, in document order. */
function pageRows(html: string): string[] {
  const open = listOf(html, 'open');
  const sealed = listOf(html, 'sealed');
  return [...(open === null ? [] : rowsIn(open)), ...(sealed === null ? [] : rowsIn(sealed))];
}

/**
 * The rows the chain implies, in the order `/tx` must print them.
 *
 * Derived here from `getBlocks()`, `getPendingBlock()` and `resolvedPosts()` —
 * never from `src/site/tx-index.ts`, which is the module under test. A post
 * contributes the hash of the record that governs it (§3.9), which is what
 * every post-centric surface on this site prints; an amendment contributes its
 * own.
 */
function expectedRows(): { hash: string; pending: boolean }[] {
  const governing = new Map(resolvedPosts().map((p) => [p.originalHash, p]));
  const out: { hash: string; pending: boolean }[] = [];
  const take = (txs: readonly RecordedTx[], inOpenBlock: boolean): void => {
    // Newest first within a block: the reverse of the order it sealed them.
    for (let i = txs.length - 1; i >= 0; i -= 1) {
      const tx = txs[i]!;
      if (tx.type === 'amendment') {
        out.push({ hash: shortHash(tx.hash), pending: inOpenBlock });
        continue;
      }
      const post = governing.get(tx.hash);
      if (post === undefined) throw new Error(`no resolved post for ${tx.hash}`);
      out.push({ hash: shortHash(post.hash), pending: post.pending });
    }
  };
  const pending = getPendingBlock();
  if (pending !== null) take(pending.transactions, true);
  for (const block of getBlocks()) take(block.transactions, false);
  return out;
}

describe('the transaction index at /tx', () => {
  it('has transactions to index at all', () => {
    // Anti-vacuity: every assertion below is a loop or a sequence comparison,
    // and an empty chain would satisfy all of them having checked nothing.
    expect(getStats().transactions).toBeGreaterThan(0);
    expect(expectedRows().length).toBe(getStats().transactions);
  });

  it('resolves as a page, not as the directory the post pages already create', () => {
    // `dist/tx/` exists the moment any one post builds, as a container for
    // `dist/tx/<slug>/`. `resolvesIn` rejects a bare directory, so this fails
    // for a `/tx` that is a nav entry and nothing else — which is the state
    // this task started from.
    expect(resolvesIn(DIST, '/tx')).toBe(true);
  });

  it('prints one row per ledger transaction, newest first', () => {
    const rows = pageRows(readDist(TX_INDEX));
    const printed = rows.map((row) => {
      const found = hashOf(row);
      expect(found, `a row on /tx prints no hash:\n${row}`).not.toBeNull();
      return found!;
    });
    expect(printed).toEqual(expectedRows());
  });

  it('states the same transaction count the network stats do', () => {
    const html = readDist(TX_INDEX);
    expect(pageRows(html)).toHaveLength(getStats().transactions);
    expect(html).toContain(`<span class="num">${getStats().transactions}</span> giao dịch`);
  });

  it('links every post it lists to that post own page', () => {
    const html = readDist(TX_INDEX);
    for (const post of resolvedPosts()) {
      expect(html, `/tx does not link ${post.slug}`).toContain(`href="/tx/${post.slug}"`);
      expect(html, `/tx does not name ${post.slug}'s current title`).toContain(
        rendered(post.title),
      );
    }
  });

  it('truncates every hash it prints, as a list must', () => {
    const text = textOf(mainOf(readDist(TX_INDEX)));
    const ledger = [
      ...getBlocks().flatMap((b) => b.transactions),
      ...(getPendingBlock()?.transactions ?? []),
    ];
    expect(ledger.length, 'the chain holds no transactions').toBeGreaterThan(0);
    for (const tx of ledger) {
      expect(text, `${tx.hash} is printed in full on a list page`).not.toContain(tx.hash);
      // Including the hash an amendment names as amended, which is the one
      // full hash the markup does carry (as `data-amends`).
      if (tx.amends !== null) {
        expect(text, `${tx.amends} is printed in full on a list page`).not.toContain(tx.amends);
        expect(text, `the amendment of ${tx.amends} does not name it`).toContain(
          shortHash(tx.amends),
        );
      }
    }
    // The other half: it prints truncated ones, so this cannot pass on a page
    // that prints no hashes at all.
    expect(expectedRows().length).toBeGreaterThan(0);
    for (const row of expectedRows()) expect(text).toContain(row.hash);
  });

  it('emits no link the build did not produce a page for', () => {
    const hrefs = internalHrefs(readDist(TX_INDEX));
    expect(hrefs.length, '/tx emitted no internal links at all').toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(resolvesIn(DIST, href), `${href} is linked from /tx but was never built`).toBe(true);
    }
  });
});

/**
 * The states the committed chain cannot show: an amendment, and a transaction
 * the chain has not sealed. A throwaway copy of the repository is driven
 * through a real `chain:build` and a real `astro build`, and its `dist/` read —
 * the same shape as `tests/site/post-rows.test.ts`, which this file's post-row
 * assertions are the `/tx` half of.
 */
const POSTS = 'content/posts';
const AMENDED = '2026-08-01-cay-phan-doan';
const FRESH = '2026-09-02-bai-chua-niem-phong';
const OLD_TITLE = 'Cây phân đoạn';
const NEW_TITLE = 'Cây phân đoạn và lazy propagation';

function writePost(dir: string, slug: string, front: Record<string, string>, body: string): void {
  const lines = ['---', ...Object.entries(front).map(([k, v]) => `${k}: ${v}`), '---', '', body, ''];
  writeFileSync(join(dir, POSTS, `${slug}.md`), lines.join('\n'));
}

interface PendingRecord {
  height: number;
  period: string;
  transactions: { hash: string; type: string; slug: string | null; amends: string | null }[];
}

describe('an amended post and an unsealed one, on /tx', () => {
  let dir = '';
  let record: PendingRecord;

  beforeAll(() => {
    // `'fixture'`: the sandbox's chain holds exactly what this file puts in it
    // plus the shared fixture posts, so the sums below are about this test's
    // own writing and not about whatever the author has published.
    dir = sandboxRepo({ content: 'fixture' });
    writePost(
      dir,
      AMENDED,
      { title: `"${OLD_TITLE}"`, date: '2026-08-01', tags: '[cau-truc-du-lieu]', research: '3.0' },
      'Ghi chú ngắn về cây phân đoạn và cách nó trả lời truy vấn đoạn.',
    );

    // Record the open 2026-08 block, then seal it. Two builds, because block
    // membership is a recorded fact (§3.6).
    for (const now of ['2026-08-10', '2026-09-02']) {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
    }

    // The edit: a new title, new declared hours and a longer body, so every
    // field the row prints has a superseded value available to print by
    // mistake. Plus a post that never seals at all.
    writePost(
      dir,
      AMENDED,
      { title: `"${NEW_TITLE}"`, date: '2026-08-01', tags: '[cau-truc-du-lieu]', research: '9.5' },
      'Ghi chú ngắn về cây phân đoạn và cách nó trả lời truy vấn đoạn.\n\n' +
        'Phần bổ sung sau khi sửa bài, đủ dài để số từ khác hẳn bản gốc.',
    );
    writePost(
      dir,
      FRESH,
      { title: '"Bài chưa niêm phong"', date: '2026-09-02', tags: '[ghi-chu]', research: '1.5' },
      'Bài viết vẫn đang nằm trong khối mở.',
    );
    const built = chainBuildSandbox(dir, '2026-09-04');
    if (built.status !== 0) throw new Error(`chain:build failed:\n${built.output}`);

    record = JSON.parse(readFileSync(join(dir, 'chain.pending.json'), 'utf8')) as PendingRecord;
    const ids = pendingIdsIn(dir);
    if (!ids.includes(FRESH)) {
      throw new Error(`the fresh post did not land in the open block: ${ids.join(', ') || 'none'}`);
    }
    if (!record.transactions.some((t) => t.type === 'amendment')) {
      throw new Error('the edit was not recorded as an amendment in the open block');
    }

    const build = buildSandbox(dir);
    if (build.status !== 0) throw new Error(`sandbox build failed:\n${build.output}`);
  }, 600_000);

  const read = (page: string): string => readFileSync(join(dir, 'dist', page), 'utf8');
  const index = (): string => read(TX_INDEX);

  /** The amendment's own row, found by the transaction it names as amended. */
  function amendmentRow(): string {
    const amendment = record.transactions.find((t) => t.type === 'amendment');
    expect(amendment, 'the sandbox recorded no amendment').toBeDefined();
    const row = pageRows(index()).find((r) => r.includes(`data-amends="${amendment!.amends}"`));
    expect(row, '/tx prints no row for the amendment the chain recorded').toBeDefined();
    return row!;
  }

  /** The row for a post, which is the one that is not an amendment's. */
  function postRow(slug: string): string {
    const row = pageRows(index()).find(
      (r) => r.includes(`href="/tx/${slug}"`) && !r.includes('data-amends='),
    );
    expect(row, `/tx prints no post row for ${slug}`).toBeDefined();
    return row!;
  }

  it('prints one row per transaction the sandbox chain recorded', () => {
    // Expected from the sandbox's own files, not from `src/` — the committed
    // `txCount` of every sealed block plus the open block's recorded length.
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      blocks: { txCount: number }[];
    };
    const total =
      lock.blocks.reduce((n, b) => n + b.txCount, 0) + record.transactions.length;
    expect(total, 'the sandbox chain holds no transactions').toBeGreaterThan(0);
    expect(pageRows(index())).toHaveLength(total);
  });

  it("says exactly what the post's own page says about an amended post", () => {
    // The Critical, as an equality between two pages rather than as three
    // expectations that could each be wrong in the same way. Every figure is
    // scraped from `/tx/<slug>`, the surface that was already right.
    const panel = read(`tx/${AMENDED}/index.html`);
    const hash = /class="a-hash"><span class="tilde">~<\/span>(0x[0-9a-f]{64})</.exec(panel)?.[1];
    const gas = /<dt>Gas used<\/dt><dd><span class="num">(\d+)<\/span> từ/.exec(panel)?.[1];
    const hours = /<dt>Value<\/dt><dd><span class="num">([\d.]+)<\/span>/.exec(panel)?.[1];
    expect(hash, '/tx/<slug> printed no unsealed hash').toBeDefined();
    expect(gas, '/tx/<slug> printed no gas figure').toBeDefined();
    expect(hours, '/tx/<slug> printed no hours figure').toBeDefined();
    expect(hours).toBe('9.5');
    expect(panel).toContain(`>${rendered(NEW_TITLE)}</h1>`);

    const row = postRow(AMENDED);
    expect(row, '/tx prints a different hash from the post page').toContain(shortHash(hash!));
    expect(row, '/tx prints the superseded word count').toContain(`${gas} từ`);
    expect(row, '/tx prints the superseded hours').toContain(`${hours} giờ`);
    expect(row, "/tx prints the original's declared hours").not.toContain('3.0 giờ');
    expect(row, '/tx names the superseded title').toContain(rendered(NEW_TITLE));
    expect(row, '/tx names the superseded title').not.toContain(`>${rendered(OLD_TITLE)}</a>`);
    expect(row, '/tx gives no sign the row describes an amendment').toContain('đã sửa');
  });

  it('gives the amendment a row of its own, naming the transaction it amends', () => {
    const amendment = record.transactions.find((t) => t.type === 'amendment')!;
    const row = amendmentRow();
    expect(row, "the amendment row does not print the amendment's own hash").toContain(
      shortHash(amendment.hash),
    );
    expect(row, 'the amendment row does not name the transaction it amends').toContain(
      shortHash(amendment.amends!),
    );
    // §3.9 — an amendment's `gasUsed` and `value` are accounting zeros, and a
    // row that printed them bare would say this post has no words.
    expect(row).toContain('đính chính · gas và giờ đã tính ở bản gốc');
    expect(row, 'the amendment row prints its accounting zeros').not.toMatch(/\b0 từ\b/);
  });

  it('links an amendment row to the post it amends, which the build produced', () => {
    // An amendment has no slug and no page of its own (§3.9); the post it
    // amends is the page that renders it, since `/tx/<slug>` shows the
    // governing record.
    const href = /href="(\/tx\/[^"]+)"/.exec(amendmentRow())?.[1];
    expect(href, 'the amendment row links nowhere').toBeDefined();
    expect(href).toBe(`/tx/${AMENDED}`);
    expect(resolvesIn(join(dir, 'dist'), href!), `${href} was never built`).toBe(true);
  });

  it('marks every unsealed row provisional, and no sealed one', () => {
    // §3.6 — "a pending hash presented with the same authority as a sealed one
    // would be the single most misleading thing this site could display."
    const html = index();
    const open = listOf(html, 'open');
    expect(open, '/tx renders no list for the open block').not.toBeNull();
    expect(html, '/tx does not say the open block is unsealed').toContain(
      '<span class="stamp open">Chưa niêm phong</span>',
    );

    const openRows = rowsIn(open!);
    expect(openRows.length, 'the open list is empty').toBeGreaterThan(0);
    for (const row of openRows) {
      const found = hashOf(row);
      expect(found, `an open-block row prints no hash:\n${row}`).not.toBeNull();
      expect(found!.pending, `an unsealed hash carries no ~ marker:\n${row}`).toBe(true);
    }

    // The contrast. Without it, "every row is pending" passes.
    const sealed = listOf(html, 'sealed');
    expect(sealed, '/tx renders no list of sealed transactions').not.toBeNull();
    const sealedRows = rowsIn(sealed!);
    expect(sealedRows.length, 'the sealed list is empty').toBeGreaterThan(0);
    const marked = sealedRows.filter((row) => hashOf(row)?.pending === true);
    // Exactly one: the amended post, whose governing record is the amendment
    // waiting in the open block. Its transaction is sealed; the hash on its row
    // is not, and the `~` follows the hash that is printed.
    expect(marked).toHaveLength(1);
    expect(marked[0]!).toContain(`href="/tx/${AMENDED}"`);
  });

  it('puts the open block first and the sealed blocks after it, newest first', () => {
    // A row's *transaction* decides where it sits, which is not the same thing
    // as the hash it prints: an amended post's row prints its amendment's hash
    // while the post transaction the row stands for is sealed elsewhere. So
    // each row is placed by what identifies it — the amendment it names, or the
    // post it links to — and the block is read from the sandbox's own files.
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      blocks: { height: number; transactions: { slug: string | null; type: string; amends: string | null }[] }[];
    };
    const placed = [
      ...lock.blocks.flatMap((b) => b.transactions.map((t) => ({ ...t, height: b.height }))),
      ...record.transactions.map((t) => ({ ...t, height: record.height })),
    ];
    const heightOf = (row: string): number => {
      const amends = /data-amends="(0x[0-9a-f]{64})"/.exec(row)?.[1];
      const found =
        amends === undefined
          ? placed.find((t) => t.type === 'post' && `/tx/${t.slug}` === /href="(\/tx\/[^"]+)"/.exec(row)?.[1])
          : placed.find((t) => t.type === 'amendment' && t.amends === amends);
      expect(found, `a row on /tx belongs to no transaction on the chain:\n${row}`).toBeDefined();
      return found!.height;
    };

    const heights = pageRows(index()).map(heightOf);
    expect(heights.length, '/tx printed no rows').toBeGreaterThan(0);
    expect(heights[0], 'the open block is not at the top').toBe(record.height);
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
    // …and the open block really is above something, so a chain with nothing
    // sealed could not satisfy this.
    expect(new Set(heights).size, 'every row sits in the same block').toBeGreaterThan(1);
  });

  it('emits no link the sandbox build did not produce a page for', () => {
    const hrefs = internalHrefs(index());
    expect(hrefs.length, '/tx emitted no internal links at all').toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(resolvesIn(join(dir, 'dist'), href), `${href} is linked from /tx but was never built`).toBe(true);
    }
  });
});
