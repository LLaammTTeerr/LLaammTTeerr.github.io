import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowFor } from './dist';
import { buildSandbox, chainBuildSandbox, pendingIdsIn, sandboxRepo } from './sandbox';

/**
 * The rows on `/address/<name>` and `/about`, and the rule that keeps them
 * honest.
 *
 * This is the file for defect shape 1: **a surface printing a field off a
 * sealed transaction while the chain's newest word on that post is an
 * amendment.** It has been fixed five times — the transaction panel, the
 * address value total, the gas figure, the research hours, and finally these
 * rows, where the header of a card and the rows of the same card disagreed:
 *
 *     header  Received 15.0 giờ nghiên cứu     (2.5 + 12.5, current)
 *     rows    … 2.5 giờ   … 4.0 giờ            (sums to 6.5, superseded)
 *     title   Mo's Algorithm                   (/tx said "… và cách tối ưu")
 *
 * Two things are asserted here that no unit test can state:
 *
 *  - the *same* amended post read off `/tx/<slug>`, `/address/<tag>` and
 *    `/about` says the same thing on all three, driven through a real
 *    `chain:build` and a real `astro build`;
 *  - the `~` marker on an unsealed hash, which §3.6 calls the single most
 *    misleading thing this site could display if it went missing. Replacing
 *    `pendingHashes.has(tx.hash)` with `false` used to leave 704/704 green.
 *
 * And one that is not about a page at all: the list of files allowed to render
 * a *ledger* row. See the last describe.
 */

const POSTS = 'content/posts';

/** A post file, written into a sandbox copy. Never into the real repository. */
function writePost(
  dir: string,
  slug: string,
  front: Record<string, string>,
  body: string,
): void {
  const lines = ['---', ...Object.entries(front).map(([k, v]) => `${k}: ${v}`), '---', '', body, ''];
  writeFileSync(join(dir, POSTS, `${slug}.md`), lines.join('\n'));
}

const read = (dir: string, page: string): string => readFileSync(join(dir, 'dist', page), 'utf8');

/**
 * A sandbox holding an amended post and an unsealed one:
 *
 *  - `AMENDED` is published and sealed into 2026-08 at 4.0 hours under one
 *    title, then edited — new title, `research: 12.5`, an extra paragraph — and
 *    recorded as an amendment sitting in the open block;
 *  - `FRESH` is published into the open block and never sealed at all.
 *
 * Both states have to be present at once: the amendment gives the resolution
 * something to resolve, and `FRESH` gives the `~` marker a subject whose
 * *original* is unsealed rather than only its amendment.
 */
const AMENDED = '2026-08-01-mo-algorithm';
const FRESH = '2026-09-02-bai-moi';
const OLD_TITLE = "Mo Algorithm";
const NEW_TITLE = "Mo Algorithm và cách tối ưu";
/**
 * The tag whose address page the sum below is read off.
 *
 * Deliberately one no fixture post and no published post carries: "the card
 * has two rows and they add up to its header" is a statement about the two
 * posts this file writes, and any third post filed under the same tag makes it
 * a statement about someone else's writing instead.
 */
const TAG = 'mo-thuat-toan';
const TAG_PAGE = `address/${TAG}.tag/index.html`;

let dir = '';

beforeAll(() => {
  // `'fixture'`: the sandbox's chain must hold exactly what this file put in
  // it, plus fixture posts that carry neither `TAG` nor either slug.
  dir = sandboxRepo({ content: 'fixture' });
  writePost(
    dir,
    AMENDED,
    { title: `"${OLD_TITLE}"`, date: '2026-08-01', tags: `[${TAG}, algorithm]`, series: 'ghi-chu', research: '4.0' },
    'Ghi chú ngắn về thuật toán Mo và cách nó sắp xếp truy vấn theo khối.',
  );

  // Record the open 2026-08 block, then seal it. Two builds, because block
  // membership is a recorded fact: sealing without the record first would place
  // the post in a later month (§3.6).
  for (const now of ['2026-08-10', '2026-09-02']) {
    const built = chainBuildSandbox(dir, now);
    if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
  }

  // The amendment. Title, declared hours and body all change, so every field a
  // row prints has a superseded value to print by mistake.
  writePost(
    dir,
    AMENDED,
    { title: `"${NEW_TITLE}"`, date: '2026-08-01', tags: `[${TAG}, algorithm]`, series: 'ghi-chu', research: '12.5' },
    'Ghi chú ngắn về thuật toán Mo và cách nó sắp xếp truy vấn theo khối.\n\n' +
      'Một đoạn bổ sung sau khi sửa bài, đủ dài để số từ của bản mới khác hẳn bản gốc.',
  );
  writePost(
    dir,
    FRESH,
    { title: '"Bài chưa niêm phong"', date: '2026-09-02', tags: `[${TAG}]`, research: '2.5' },
    'Bài viết vẫn đang nằm trong khối mở.',
  );
  const record = chainBuildSandbox(dir, '2026-09-04');
  if (record.status !== 0) throw new Error(`chain:build failed:\n${record.output}`);

  const pending = pendingIdsIn(dir);
  if (!pending.includes(FRESH)) {
    throw new Error(`the fresh post did not land in the open block: ${pending.join(', ') || 'none'}`);
  }

  const build = buildSandbox(dir);
  if (build.status !== 0) throw new Error(`sandbox build failed:\n${build.output}`);
}, 600_000);

/** Every surface that renders a post row, keyed by where the row lives. */
function surfaces(slug: string): Record<string, string> {
  return {
    '/about': rowFor(read(dir, 'about/index.html'), slug)!,
    [`/address/${TAG}.tag`]: rowFor(read(dir, TAG_PAGE), slug)!,
  };
}

describe('an amended post, read off every surface that describes it', () => {
  it('names the amendment title, never the one the chain superseded', () => {
    const panel = read(dir, `tx/${AMENDED}/index.html`);
    expect(panel).toContain(`>${NEW_TITLE}</h1>`);
    for (const [where, row] of Object.entries(surfaces(AMENDED))) {
      expect(row, `${AMENDED} has no row on ${where}`).toBeTruthy();
      expect(row, `${where} names the superseded title`).toContain(NEW_TITLE);
      expect(row, `${where} names the superseded title`).not.toContain(`>${OLD_TITLE}</a>`);
    }
  });

  it('prints the same hash, word count and hours as the post own page', () => {
    // The Critical, stated as an equality between pages rather than as three
    // separate expectations that could each be wrong in the same way. Every
    // figure is scraped from `/tx/<slug>`'s own panel, which is the surface
    // that was already right.
    const tx = read(dir, `tx/${AMENDED}/index.html`);
    const hash = /class="a-hash"><span class="tilde">~<\/span>(0x[0-9a-f]{64})</.exec(tx)?.[1];
    const gas = /<dt>Gas used<\/dt><dd><span class="num">(\d+)<\/span> từ/.exec(tx)?.[1];
    const hours = /<dt>Value<\/dt><dd><span class="num">([\d.]+)<\/span>/.exec(tx)?.[1];
    expect(hash, '/tx printed no unsealed hash').toBeDefined();
    expect(gas, '/tx printed no gas figure').toBeDefined();
    expect(hours, '/tx printed no hours figure').toBeDefined();
    expect(hours).toBe('12.5');

    const short = `${hash!.slice(0, 8)}…${hash!.slice(-6)}`;
    for (const [where, row] of Object.entries(surfaces(AMENDED))) {
      expect(row, `${where} prints a different hash from /tx`).toContain(short);
      expect(row, `${where} prints the superseded word count`).toContain(`${gas} từ`);
      expect(row, `${where} prints the superseded hours`).toContain(`${hours} giờ`);
      expect(row, `${where} prints the original's declared hours`).not.toContain('4.0 giờ');
    }
  });

  it('says the row is an amendment, and points at where it sits', () => {
    // §3.9 — the hash on the row is the amendment's, while `/blocks` and the
    // sealed block's page still show the original's for this post. Without a
    // marker the two are simply different numbers for one post.
    for (const [where, row] of Object.entries(surfaces(AMENDED))) {
      expect(row, `${where} gives no sign the row describes an amendment`).toContain('đã sửa');
    }
  });

  it('leaves an unamended post reading exactly as it did', () => {
    // The control: resolution must not disturb a post nothing amends.
    for (const [where, row] of Object.entries(surfaces(FRESH))) {
      expect(row, `${FRESH} has no row on ${where}`).toBeTruthy();
      expect(row).toContain('2.5 giờ');
      expect(row, `${where} marked an unamended post as amended`).not.toContain('đã sửa');
    }
  });

  it('sums the rows to the total each card states', () => {
    // The tag received the amended post (12.5) and the fresh one (2.5), and
    // nothing else — see `TAG`.
    const card = read(dir, TAG_PAGE);
    const rows = [...card.matchAll(/· ([\d.]+) giờ/g)].map((m) => Number(m[1]!));
    const total = /<dt>Received<\/dt><dd><span class="num">([\d.]+)<\/span>/.exec(card);
    expect(total, 'the card states no Received total').not.toBeNull();
    expect(rows.length).toBe(2);
    expect(rows.reduce((a, b) => a + b, 0)).toBeCloseTo(Number(total![1]!), 5);
    expect(Number(total![1]!), 'the total is still the pre-amendment sum').not.toBeCloseTo(6.5, 5);
  });
});

describe('the tilde on a hash the chain has not sealed (§3.6)', () => {
  it('marks an unsealed row and leaves a sealed one unmarked, on both surfaces', () => {
    // Uncovered by anything: replacing `pendingHashes.has(tx.hash)` with
    // `false` — every unsealed transaction rendered with a sealed hash's
    // treatment — left 704/704 green. §3.6: "a pending hash presented with the
    // same authority as a sealed one would be the single most misleading thing
    // this site could display."
    //
    // The chain here has both: `FRESH` is unsealed, and a fixture post is
    // sealed and unamended.
    const sealedSlug = readdirSync(join(dir, POSTS))
      .map((f) => f.replace(/\.md$/, ''))
      .find((slug) => slug !== AMENDED && slug !== FRESH);
    expect(sealedSlug, 'the sandbox has no sealed, unamended post to contrast with').toBeDefined();

    for (const page of ['about/index.html', TAG_PAGE]) {
      const html = read(dir, page);
      const fresh = rowFor(html, FRESH);
      expect(fresh, `${FRESH} has no row on /${page}`).not.toBeNull();
      expect(fresh!, `an unsealed hash on /${page} carries no ~ marker`).toContain(
        '<span class="a-hash"><span class="tilde">~</span>',
      );
      expect(fresh!, `an unsealed hash on /${page} was given the sealed treatment`).not.toContain(
        '<span class="hash">',
      );
    }

    // The contrast, on the one page that lists the sealed post: no tilde, and
    // the sealed treatment. Without this half, "everything is pending" passes.
    const about = read(dir, 'about/index.html');
    const sealed = rowFor(about, sealedSlug!);
    expect(sealed, `${sealedSlug} has no row on /about`).not.toBeNull();
    expect(sealed!, 'a sealed hash was marked unsealed').not.toContain('class="tilde"');
    expect(sealed!).toContain('<span class="hash">');
  });

  it('marks an amended row unsealed while its amendment waits, though the post is sealed', () => {
    // The subtle half. `AMENDED`'s original is in a sealed block; the record
    // the row now describes is its amendment, which is not. The `~` follows the
    // hash that is printed, not the post's own history.
    for (const [where, row] of Object.entries(surfaces(AMENDED))) {
      expect(row, `${where} stamped a pending amendment with a sealed hash`).toContain(
        '<span class="tilde">~</span>',
      );
    }
  });
});

describe('the rule that keeps a sixth surface from acquiring this bug', () => {
  /**
   * `txMetaLine` renders a **ledger** row: a transaction inside a block, where
   * the sealed figures are the truth about that block and an amendment appears
   * as a row of its own. `postMetaLine`/`TxRow` render a **post** row, which
   * must resolve (§3.9).
   *
   * The type system carries most of this — `ResolvedPost` has a `resolved`
   * brand no ledger type has, so `TxRow` and `TxPanel` cannot be handed a
   * `Transaction` and `npm run typecheck` says so. What it cannot carry is a
   * new page that hand-rolls a row out of `txMetaLine` and `tx.title`. This
   * is the list of files that may, and it is short on purpose.
   */
  const LEDGER_ROW_FILES = [
    'src/components/BlockCard.astro',
    'src/pages/block/[height].astro',
    // `/tx`, which is a ledger view too and for the same reason: it indexes
    // *transactions*, so a row is one transaction printing its own hash, title
    // and figures — the state that block sealed. Resolving there put an
    // amendment's hash on two rows and left the post transaction's own hash on
    // none. "What is this post now" is `/tx/<slug>`, which resolves.
    'src/components/LedgerRow.astro',
  ];

  function astroFiles(dir = 'src'): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...astroFiles(path));
      else if (entry.name.endsWith('.astro')) out.push(path);
    }
    return out;
  }

  it('lets only a block view render a row from a raw ledger transaction', () => {
    const users = astroFiles().filter((f) => readFileSync(f, 'utf8').includes('txMetaLine'));
    expect(users.sort()).toEqual([...LEDGER_ROW_FILES].sort());
  });

  it('renders every post row through the one component that takes a resolved post', () => {
    // `/address/[name]` and `/about` are the two surfaces the Critical was
    // found at. Neither may build a row itself again.
    for (const page of ['src/pages/address/[name].astro', 'src/pages/about.astro']) {
      const source = readFileSync(page, 'utf8');
      expect(source, `${page} does not use TxRow`).toContain('<TxRow post={post} />');
      expect(source, `${page} reads a title off a transaction directly`).not.toMatch(/tx\.title/);
      expect(source, `${page} reads a hash off a transaction directly`).not.toMatch(/tx\.hash/);
    }
  });

  it('keeps the resolution off the surfaces that index transactions', () => {
    // The other direction, and the one `/tx` got wrong first. A *ledger* view
    // must not resolve: `/blocks`, `/block/<height>` and `/tx` each describe
    // transactions, and a resolved row there prints an amendment's hash under a
    // post transaction's row — so one hash lands on two rows and another on
    // none. `ResolvedPost` is the type these files may not touch.
    for (const page of [...LEDGER_ROW_FILES, 'src/pages/tx/index.astro', 'src/site/tx-index.ts']) {
      const source = readFileSync(page, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${page} resolves a post to render a ledger row`).not.toMatch(
        /\bResolvedPost\b|\bresolvedPosts\b|\bresolvePost\b|\bpostMetaLine\b|<TxRow\b/,
      );
    }
  });

  it('keeps the resolution in one place', () => {
    // `latestAmendment` is the walk. Two of them is how a surface ends up with
    // its own idea of which record governs a post.
    const source = readFileSync('src/site/chain-data.ts', 'utf8');
    expect(source.match(/function latestAmendment\b/g)).toHaveLength(1);
    // And nothing outside this module may walk for one: it is not exported.
    expect(source).not.toMatch(/export function latestAmendment\b/);
  });
});
