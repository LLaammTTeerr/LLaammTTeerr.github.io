import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, internalHrefs, readDist, rendered, resolvesIn } from './dist';
import { buildSandbox, chainBuildSandbox, pendingIdsIn, sandboxRepo } from './sandbox';
import { getBlocks, getPendingBlock, getPosts, getStats, shortHash } from '../../src/site/chain-data';
import type { RecordedTx } from '../../src/site/chain-data';

/**
 * `/tx` — the transaction index.
 *
 * The counterpart of `/blocks`, and the same *kind* of surface as it: a row is
 * one transaction, printing its own hash and its own committed fields. Three
 * properties carry this file, and all three were wrong in the first version of
 * this page, which resolved its post rows the way `/address/<name>` does:
 *
 *  - **every transaction on the chain appears exactly once.** Resolving put an
 *    amended post's row on the amendment's hash, so that hash sat on two rows
 *    while the post transaction's own hash sat on none;
 *  - **no hash appears on two rows.** The same defect from the other side,
 *    which a count alone cannot see;
 *  - **`/tx` and `/blocks` name a transaction the same way.** The cross-page
 *    invariant the fix is really about, and it needs a chain that contains an
 *    amendment — the sandbox below seals one.
 *
 * Nothing here asserts on nav chrome: the nav renders identically on every page
 * in the site, so `href="/tx"` in it is satisfied by `Base.astro` alone and says
 * nothing about whether this route exists. What this file adds to
 * `tests/site/nav.test.ts` is that `/tx` resolves to a *page* rather than to the
 * bare `dist/tx/` directory the post pages already create.
 */

const TX_INDEX = 'tx/index.html';

/** One of the page's two transaction lists, or `null` when it renders none. */
function listOf(html: string, which: 'open' | 'sealed'): string | null {
  const m = new RegExp(`<ul[^>]*data-tx-list="${which}"[^>]*>([\\s\\S]*?)</ul>`).exec(html);
  return m === null ? null : m[1]!;
}

/** The `<li>` rows of one list or card, in document order. */
function rowsIn(list: string): string[] {
  return [...list.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]);
}

/** Every row `/tx` prints, both lists, in document order. */
function pageRows(html: string): string[] {
  const open = listOf(html, 'open');
  const sealed = listOf(html, 'sealed');
  return [...(open === null ? [] : rowsIn(open)), ...(sealed === null ? [] : rowsIn(sealed))];
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
 * §3.2's display rule is about what is *shown*: `data-tx` and `data-amends`
 * carry committed hashes exactly as `data-block` carries a height, and an
 * attribute is not a display. Asserting over raw markup would forbid the
 * attributes rather than the untruncated hash.
 */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** The transaction a row stands for — its identity, not what it happens to print. */
function txOf(row: string): string | null {
  return /data-tx="(0x[0-9a-f]{64})"/.exec(row)?.[1] ?? null;
}

/**
 * The hash a row *displays*, and whether it is marked unsealed.
 *
 * The first hash in the row, deliberately: an amendment row also names the
 * transaction it amends, and that reference must never be mistaken for the
 * row's own identity.
 */
const ROW_HASH =
  /<span class="a-hash"><span class="tilde">~<\/span>(0x[0-9a-f]{6}…[0-9a-f]{6})<\/span>|<span class="hash">(0x[0-9a-f]{6}…[0-9a-f]{6})<\/span>/;

function hashOf(row: string): { hash: string; pending: boolean } | null {
  const m = ROW_HASH.exec(row);
  if (m === null) return null;
  return m[1] === undefined ? { hash: m[2]!, pending: false } : { hash: m[1], pending: true };
}

/** A row's title, as text. `/tx` heads a row with `h2`, a block card with `h3`. */
function titleText(row: string): string {
  const m = /<h[23][^>]*class="t"[^>]*>([\s\S]*?)<\/h[23]>/.exec(row);
  return m === null ? '' : textOf(m[1]!).trim();
}

/** Everything a row says after its title, as text. */
function metaText(row: string): string {
  const at = row.search(/<\/h[23]>/);
  return at === -1 ? '' : textOf(row.slice(at)).trim();
}

/**
 * Every transaction the chain holds, in the order `/tx` must print them: the
 * open block first, then sealed blocks newest first, and inside a block the
 * reverse of the order it sealed them.
 *
 * Derived from `getBlocks()`/`getPendingBlock()` — never from
 * `src/site/tx-index.ts`, which is the module under test.
 */
function expectedTxs(): { tx: RecordedTx; pending: boolean }[] {
  const out: { tx: RecordedTx; pending: boolean }[] = [];
  const take = (txs: readonly RecordedTx[], pending: boolean): void => {
    for (let i = txs.length - 1; i >= 0; i -= 1) out.push({ tx: txs[i]!, pending });
  };
  const open = getPendingBlock();
  if (open !== null) take(open.transactions, true);
  for (const block of getBlocks()) take(block.transactions, false);
  return out;
}

describe('the transaction index at /tx', () => {
  it('has transactions to index at all', () => {
    // Anti-vacuity: every assertion below is a loop or a sequence comparison,
    // and an empty chain would satisfy all of them having checked nothing.
    expect(getStats().transactions).toBeGreaterThan(0);
    expect(expectedTxs()).toHaveLength(getStats().transactions);
  });

  it('resolves as a page, not as the directory the post pages already create', () => {
    // `dist/tx/` exists the moment any one post builds, as a container for
    // `dist/tx/<slug>/`. `resolvesIn` rejects a bare directory, so this fails
    // for a `/tx` that is a nav entry and nothing else — the state this task
    // started from.
    expect(resolvesIn(DIST, '/tx')).toBe(true);
  });

  it('prints one row per ledger transaction, newest first', () => {
    // Count, membership and order in one statement. A count alone passes on a
    // page that lists the right number of the wrong things.
    const rows = pageRows(readDist(TX_INDEX));
    expect(rows.map(txOf)).toEqual(expectedTxs().map((e) => e.tx.hash));
  });

  it('gives every transaction its own hash, and no hash two rows', () => {
    // The defect this page shipped once: a resolved post row printed its
    // *amendment's* hash, so one hash appeared twice and the post
    // transaction's own hash appeared nowhere on an index of transactions.
    const rows = pageRows(readDist(TX_INDEX));
    const shown: string[] = [];
    for (const row of rows) {
      const identity = txOf(row);
      const displayed = hashOf(row);
      expect(identity, `a row on /tx names no transaction:\n${row}`).not.toBeNull();
      expect(displayed, `a row on /tx prints no hash:\n${row}`).not.toBeNull();
      expect(
        displayed!.hash,
        `a row prints a hash that is not its own transaction's:\n${row}`,
      ).toBe(shortHash(identity!));
      shown.push(displayed!.hash);
    }
    expect(new Set(shown).size, 'one hash is printed on more than one row').toBe(shown.length);
    expect(shown.length, '/tx printed no rows').toBeGreaterThan(0);
  });

  it('marks a row unsealed exactly when its block is the open one', () => {
    const rows = pageRows(readDist(TX_INDEX));
    const expected = expectedTxs();
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, i) => {
      expect(hashOf(row)!.pending, `${expected[i]!.tx.hash} is marked wrongly`).toBe(
        expected[i]!.pending,
      );
    });
  });

  it('states the same transaction count the network stats do', () => {
    const html = readDist(TX_INDEX);
    expect(pageRows(html)).toHaveLength(getStats().transactions);
    expect(html).toContain(`<span class="num">${getStats().transactions}</span> giao dịch`);
  });

  it('links every post it lists to that post own page', () => {
    const html = readDist(TX_INDEX);
    const posts = getPosts();
    expect(posts.length, 'the chain holds no posts').toBeGreaterThan(0);
    for (const tx of posts) {
      const row = pageRows(html).find((r) => txOf(r) === tx.hash);
      expect(row, `/tx has no row for ${tx.slug}`).toBeDefined();
      expect(row!, `/tx does not link ${tx.slug}`).toContain(`href="/tx/${tx.slug}"`);
      expect(row!, `/tx does not print ${tx.slug}'s committed title`).toContain(
        rendered(tx.title ?? ''),
      );
    }
  });

  it('truncates every hash it prints, as a list must', () => {
    const text = textOf(mainOf(readDist(TX_INDEX)));
    const ledger = expectedTxs();
    expect(ledger.length, 'the chain holds no transactions').toBeGreaterThan(0);
    for (const { tx } of ledger) {
      expect(text, `${tx.hash} is printed in full on a list page`).not.toContain(tx.hash);
      expect(text, `${tx.hash} is not printed at all`).toContain(shortHash(tx.hash));
      if (tx.amends !== null) {
        expect(text, `${tx.amends} is printed in full on a list page`).not.toContain(tx.amends);
        expect(text, `the amendment of ${tx.amends} does not name it`).toContain(
          shortHash(tx.amends),
        );
      }
    }
  });

  it('ends no row on a dangling separator', () => {
    // A meta line is built from optional segments — the `sửa <hash>` reference
    // is on amendments only — and a separator that belongs to a segment which
    // did not render leaves `… · ` with nothing after it.
    for (const row of pageRows(readDist(TX_INDEX))) {
      const meta = metaText(row);
      expect(meta, `a row's meta line is empty:\n${row}`).not.toBe('');
      expect(meta, `a row's meta line ends on a separator: ${JSON.stringify(meta)}`).not.toMatch(
        /·\s*$/,
      );
    }
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
 * The states the committed chain cannot show: a **sealed amendment**, and a
 * transaction the chain has not sealed at all. A throwaway copy of the
 * repository is driven through real `chain:build` runs and a real `astro
 * build`, and its `dist/` read.
 *
 * The amendment has to be sealed, not merely recorded, because the invariant
 * under test is that `/tx` and `/blocks` name the same transaction the same
 * way — and `/blocks` shows a sealed amendment inside the card of the block
 * that sealed it, which is the row `/tx` must agree with.
 */
const POSTS = 'content/posts';
const AMENDED = '2026-08-01-cay-phan-doan';
const FRESH = '2026-10-05-bai-chua-niem-phong';
const OLD_TITLE = 'Cây phân đoạn';
const NEW_TITLE = 'Cây phân đoạn và lazy propagation';

function writePost(dir: string, slug: string, front: Record<string, string>, body: string): void {
  const lines = ['---', ...Object.entries(front).map(([k, v]) => `${k}: ${v}`), '---', '', body, ''];
  writeFileSync(join(dir, POSTS, `${slug}.md`), lines.join('\n'));
}

interface LockTx {
  hash: string;
  type: string;
  slug: string | null;
  title: string | null;
  amends: string | null;
}
interface Lock {
  blocks: { height: number; txCount: number; transactions: LockTx[] }[];
}
interface PendingRecord {
  height: number;
  period: string;
  transactions: LockTx[];
}

describe('a sealed amendment and an unsealed post, on /tx', () => {
  let dir = '';
  let lock: Lock;
  let record: PendingRecord;

  beforeAll(() => {
    // `'fixture'`: the sandbox's chain holds exactly what this file puts in it
    // plus the shared fixture posts, so what is asserted is about this test's
    // own writing and not about whatever the author has published.
    dir = sandboxRepo({ content: 'fixture' });
    const run = (now: string): void => {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
    };

    writePost(
      dir,
      AMENDED,
      { title: `"${OLD_TITLE}"`, date: '2026-08-01', tags: '[cau-truc-du-lieu]', research: '3.0' },
      'Ghi chú ngắn về cây phân đoạn và cách nó trả lời truy vấn đoạn.',
    );
    // Record the open 2026-08 block, then seal it. Two builds, because block
    // membership is a recorded fact (§3.6), not a function of today's date.
    run('2026-08-10');
    run('2026-09-02');

    // The edit: new title, new declared hours, longer body — so every field a
    // row prints has a superseded value available to print by mistake. Recorded
    // into the open 2026-09 block, then sealed by the build after it.
    writePost(
      dir,
      AMENDED,
      { title: `"${NEW_TITLE}"`, date: '2026-08-01', tags: '[cau-truc-du-lieu]', research: '9.5' },
      'Ghi chú ngắn về cây phân đoạn và cách nó trả lời truy vấn đoạn.\n\n' +
        'Phần bổ sung sau khi sửa bài, đủ dài để số từ khác hẳn bản gốc.',
    );
    run('2026-09-10');
    run('2026-10-02');

    // …and a post that never seals at all, so the open block is not empty.
    writePost(
      dir,
      FRESH,
      { title: '"Bài chưa niêm phong"', date: '2026-10-05', tags: '[ghi-chu]', research: '1.5' },
      'Bài viết vẫn đang nằm trong khối mở.',
    );
    run('2026-10-10');

    lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as Lock;
    record = JSON.parse(readFileSync(join(dir, 'chain.pending.json'), 'utf8')) as PendingRecord;
    const ids = pendingIdsIn(dir);
    if (!ids.includes(FRESH)) {
      throw new Error(`the fresh post did not land in the open block: ${ids.join(', ') || 'none'}`);
    }
    if (!lock.blocks.some((b) => b.transactions.some((t) => t.type === 'amendment'))) {
      throw new Error('the edit was never sealed as an amendment');
    }
    if (record.transactions.some((t) => t.type === 'amendment')) {
      throw new Error('an amendment is still pending; the sealed case is not isolated');
    }

    const build = buildSandbox(dir);
    if (build.status !== 0) throw new Error(`sandbox build failed:\n${build.output}`);
  }, 900_000);

  const read = (page: string): string => readFileSync(join(dir, 'dist', page), 'utf8');
  const index = (): string => read(TX_INDEX);

  /** Where a transaction sits, from the sandbox's own files. */
  function placed(): { tx: LockTx; height: number; pending: boolean }[] {
    return [
      ...record.transactions.map((tx) => ({ tx, height: record.height, pending: true })),
      ...lock.blocks.flatMap((b) =>
        b.transactions.map((tx) => ({ tx, height: b.height, pending: false })),
      ),
    ];
  }

  const original = (): LockTx => {
    const tx = placed().find((p) => p.tx.slug === AMENDED)?.tx;
    expect(tx, 'the sandbox holds no post transaction for the amended post').toBeDefined();
    return tx!;
  };
  const amendment = (): { tx: LockTx; height: number } => {
    const found = placed().find((p) => p.tx.type === 'amendment');
    expect(found, 'the sandbox recorded no amendment').toBeDefined();
    return found!;
  };
  const rowFor = (hash: string): string => {
    const row = pageRows(index()).find((r) => txOf(r) === hash);
    expect(row, `/tx has no row for ${hash}`).toBeDefined();
    return row!;
  };

  /**
   * One block's card on `/blocks`. Split rather than matched: a card is nested
   * markup, and `data-block` starts each one.
   */
  function blockCard(html: string, height: number): string {
    const parts = html.split('<div class="row" data-block="');
    const part = parts.find((p) => p.startsWith(`${height}"`));
    expect(part, `/blocks renders no card for block #${height}`).toBeDefined();
    return part!;
  }

  it('prints one row per transaction the sandbox chain recorded', () => {
    // Expected from the sandbox's own files: the committed `txCount` of every
    // sealed block plus the open block's recorded length.
    const total = lock.blocks.reduce((n, b) => n + b.txCount, 0) + record.transactions.length;
    expect(total, 'the sandbox chain holds no transactions').toBeGreaterThan(0);
    const rows = pageRows(index());
    expect(rows).toHaveLength(total);
    // …and each one exactly once, by identity and by what it prints.
    const ids = rows.map(txOf);
    expect(new Set(ids).size, 'a transaction is on two rows').toBe(ids.length);
    expect([...ids].sort()).toEqual(placed().map((p) => p.tx.hash).sort());
    const shown = rows.map((r) => hashOf(r)!.hash);
    expect(new Set(shown).size, 'one hash is printed on more than one row').toBe(shown.length);
  });

  it('names an amended post the way /blocks names it, in the block that sealed it', () => {
    // The cross-page invariant. `/blocks` describes what a block sealed; `/tx`
    // indexes the same transactions, so for one transaction the two pages must
    // print one title and one meta line. When `/tx` resolved, they printed
    // different titles for this very transaction with nothing saying why.
    const post = original();
    const at = placed().find((p) => p.tx.hash === post.hash)!;
    const onBlocks = rowsIn(blockCard(read('blocks/index.html'), at.height)).find((r) =>
      r.includes(`href="/tx/${AMENDED}"`),
    );
    expect(onBlocks, `/blocks does not list ${AMENDED} in block #${at.height}`).toBeDefined();

    const onIndex = rowFor(post.hash);
    expect(titleText(onIndex), '/tx and /blocks name this transaction differently').toBe(
      titleText(onBlocks!),
    );
    expect(titleText(onIndex)).toBe(OLD_TITLE);
    expect(
      metaText(onIndex),
      "/tx does not print the block card's own figures for this transaction",
    ).toContain(metaText(onBlocks!));

    // …and its identity is its own, not the amendment's.
    expect(onIndex, "/tx prints another transaction's hash for this post").toContain(
      shortHash(post.hash),
    );
    expect(onIndex, "/tx prints the amendment's hash on the post's row").not.toContain(
      shortHash(amendment().tx.hash),
    );
    expect(onIndex, '/tx prints the superseded title on the post row').not.toContain(
      rendered(NEW_TITLE),
    );
    expect(metaText(onIndex), "/tx prints the amendment's declared hours").not.toContain('9.5 giờ');
    expect(metaText(onIndex)).toContain('3.0 giờ');

    // The current state is a click away, and still resolved — which is the
    // reason this page does not have to be.
    expect(read(`tx/${AMENDED}/index.html`), '/tx/<slug> stopped resolving').toContain(
      `>${rendered(NEW_TITLE)}</h1>`,
    );
  });

  it('gives the amendment its own row, named as /blocks names it', () => {
    const { tx, height } = amendment();
    const onBlocks = rowsIn(blockCard(read('blocks/index.html'), height)).find(
      (r) => !r.includes('href="/tx/'),
    );
    expect(onBlocks, `/blocks does not list the amendment in block #${height}`).toBeDefined();

    const onIndex = rowFor(tx.hash);
    expect(titleText(onIndex), '/tx and /blocks name the amendment differently').toBe(
      titleText(onBlocks!),
    );
    expect(titleText(onIndex)).toBe(NEW_TITLE);
    expect(onIndex, "the amendment row does not print the amendment's own hash").toContain(
      shortHash(tx.hash),
    );
    expect(onIndex, 'the amendment row does not name the transaction it amends').toContain(
      shortHash(original().hash),
    );
    // §3.9 — an amendment's `gasUsed` and `value` are accounting zeros, and a
    // row that printed them bare would say this post has no words.
    expect(metaText(onIndex)).toContain('đính chính · gas và giờ đã tính ở bản gốc');
    expect(metaText(onIndex), 'the amendment row prints its accounting zeros').not.toMatch(
      /\b0 từ\b/,
    );
  });

  it('links an amendment row to the post it amends, which the build produced', () => {
    // An amendment has no slug and no page of its own (§3.9); the post it
    // amends is the page that renders it, since `/tx/<slug>` shows the
    // governing record.
    const href = /href="(\/tx\/[^"]+)"/.exec(rowFor(amendment().tx.hash))?.[1];
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
      expect(hashOf(row)!.pending, `an unsealed hash carries no ~ marker:\n${row}`).toBe(true);
    }

    // The contrast. Without it, "every row is pending" passes — and now that a
    // row states its own transaction, the sealed group holds only sealed
    // hashes, which is what lets it carry the `Sealed` stamp at all.
    const sealed = listOf(html, 'sealed');
    expect(sealed, '/tx renders no list of sealed transactions').not.toBeNull();
    const sealedRows = rowsIn(sealed!);
    expect(sealedRows.length, 'the sealed list is empty').toBeGreaterThan(0);
    for (const row of sealedRows) {
      expect(hashOf(row)!.pending, `a sealed hash was marked unsealed:\n${row}`).toBe(false);
    }
    expect(html, '/tx does not stamp the sealed group').toContain(
      '<span class="stamp">Sealed</span>',
    );
  });

  it('puts the open block first and the sealed blocks after it, newest first', () => {
    const at = new Map(placed().map((p) => [p.tx.hash, p.height]));
    const heights = pageRows(index()).map((row) => at.get(txOf(row) ?? ''));
    expect(heights.every((h) => h !== undefined), 'a row belongs to no block').toBe(true);
    expect(heights[0], 'the open block is not at the top').toBe(record.height);
    expect(heights as number[]).toEqual([...(heights as number[])].sort((a, b) => b - a));
    expect(new Set(heights).size, 'every row sits in the same block').toBeGreaterThan(1);
  });

  it('emits no link the sandbox build did not produce a page for', () => {
    const hrefs = internalHrefs(index());
    expect(hrefs.length, '/tx emitted no internal links at all').toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(
        resolvesIn(join(dir, 'dist'), href),
        `${href} is linked from /tx but was never built`,
      ).toBe(true);
    }
  });
});
