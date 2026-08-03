import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRules, selectorParts } from './css';
import { DIST, distPages, readDist, resolvesIn } from './dist';
import { buildSandbox, chainBuildSandbox, pendingIdsIn, sandboxRepo } from './sandbox';
import { getDrafts } from '../../src/site/drafts';
import { routeById } from '../../src/site/routes';

/**
 * §3.6 — `/mempool` holds **drafts**, which are not in the chain at all, and
 * must not be confused with the open block's published-but-unsealed posts.
 *
 * A draft has no hash, no address, no gas and no value. Every assertion about
 * their absence is scoped to the draft list itself: the page's own prose says
 * the words "hash" and "khối", and the nav and `<title>` echo the page name,
 * so an unscoped `not.toContain` would either pass trivially or fail on chrome
 * that has nothing to do with a draft.
 *
 * `content/drafts/` ships empty, which is the state this route lives in almost
 * always — so the populated cases are driven through a *sandbox copy* of the
 * repository with real draft files and a real `astro build`, never against the
 * live tree. The empty case is built in the same sandbox before the fixtures
 * are written, so both states come from a controlled input rather than from
 * whatever the repository happens to hold on the day.
 */

const draftFile = (title: string, date: string, body: string): string =>
  ['---', `title: "${title}"`, `date: ${date}`, '---', '', body, ''].join('\n');

/** The draft list, without the card, the prose and the layout around it. */
function listOf(html: string): string {
  const m = /<ul class="mem">[\s\S]*?<\/ul>/.exec(html);
  if (m === null) throw new Error('the page rendered no draft list');
  return m[0];
}

/** The mempool card, including its explanatory prose and empty state. */
function cardOf(html: string): string {
  const m = /<article class="card offchain"[\s\S]*?<\/article>/.exec(html);
  if (m === null) throw new Error('the page has no mempool card');
  return m[0];
}

/** Titles in the order the draft list renders them. */
function titlesIn(list: string): string[] {
  return [...list.matchAll(/<h2 class="t">([^<]*)<\/h2>/g)].map((m) => m[1]!);
}

const NEWER = { slug: '2026-09-04-ban-nhap-moi', title: 'Bản nháp mới hơn', date: '2026-09-04' };
const OLDER = { slug: '2026-08-11-ban-nhap-cu', title: 'Bản nháp cũ hơn', date: '2026-08-11' };

let emptyHtml = '';
let draftsHtml = '';
let homeWithDrafts = '';
let blocksWithDrafts = '';

beforeAll(() => {
  const dir = sandboxRepo();
  const drafts = join(dir, 'content/drafts');
  mkdirSync(drafts, { recursive: true });

  // The empty state first — it is the state this route ships in, and building
  // it before the fixtures exist also serves as the control: a failure below
  // is then the page's behaviour, not a broken sandbox.
  const empty = buildSandbox(dir);
  if (empty.status !== 0) throw new Error(`control build of an empty mempool failed:\n${empty.output}`);
  emptyHtml = readFileSync(join(dir, 'dist/mempool/index.html'), 'utf8');

  writeFileSync(join(drafts, `${OLDER.slug}.md`), draftFile(OLDER.title, OLDER.date, 'Đoạn ghi chú còn dở.'));
  writeFileSync(join(drafts, `${NEWER.slug}.md`), draftFile(NEWER.title, NEWER.date, 'Ý tưởng chưa viết xong.'));

  const built = buildSandbox(dir);
  if (built.status !== 0) throw new Error(`sandbox build with drafts failed:\n${built.output}`);
  draftsHtml = readFileSync(join(dir, 'dist/mempool/index.html'), 'utf8');
  homeWithDrafts = readFileSync(join(dir, 'dist/index.html'), 'utf8');
  blocksWithDrafts = readFileSync(join(dir, 'dist/blocks/index.html'), 'utf8');
}, 300_000);

describe('getDrafts', () => {
  function fixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'drafts-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it('lists drafts newest first', () => {
    const dir = fixtureDir({
      'b.md': draftFile('Giữa', '2026-05-02', 'x'),
      'a.md': draftFile('Cũ nhất', '2026-01-09', 'x'),
      'c.md': draftFile('Mới nhất', '2026-07-20', 'x'),
    });
    // Filenames sort a, b, c and dates sort the other way, so a list that
    // simply took `readdirSync` order passes nothing here.
    expect(getDrafts(dir).map((d) => d.title)).toEqual(['Mới nhất', 'Giữa', 'Cũ nhất']);
    expect(getDrafts(dir).map((d) => d.slug)).toEqual(['c', 'b', 'a']);
  });

  it('is a title and a date and nothing else — no hash, address, gas or value', () => {
    // §3.6: a draft is not in the chain, so there is no field on it that could
    // truthfully carry one. Checked as the whole key set, because a template
    // can only print what the view hands it.
    const dir = fixtureDir({ 'x.md': draftFile('Nháp', '2026-03-03', 'x') });
    const draft = getDrafts(dir)[0]!;
    expect(Object.keys(draft).sort()).toEqual(['date', 'slug', 'title']);
    expect(JSON.stringify(draft)).not.toMatch(/0x/);
  });

  it('returns nothing for an empty directory, and for one that is not there', () => {
    expect(getDrafts(fixtureDir({}))).toEqual([]);
    expect(getDrafts(join(tmpdir(), 'blogchain-no-such-drafts-dir'))).toEqual([]);
  });

  it('ignores anything that is not a markdown file', () => {
    const dir = fixtureDir({
      '.gitkeep': '',
      'notes.txt': 'không phải bài viết',
      'x.md': draftFile('Nháp', '2026-03-03', 'x'),
    });
    expect(getDrafts(dir).map((d) => d.slug)).toEqual(['x']);
  });

  it('refuses a slug that is also a published post', () => {
    // The brief's "does not confuse a draft with a pending transaction" check,
    // written so it can actually fail. As an assertion over the live repository
    // it never could: `content/drafts/` ships empty, so the intersection is
    // empty whatever the code does — and once the collision is a build error,
    // `getDrafts()` throws before any intersection can be computed.
    const posts = mkdtempSync(join(tmpdir(), 'posts-'));
    writeFileSync(join(posts, 'trung-slug.md'), draftFile('Đã đăng', '2026-04-01', 'x'));
    const drafts = fixtureDir({ 'trung-slug.md': draftFile('Vẫn còn nháp', '2026-04-01', 'x') });

    expect(() => getDrafts(drafts, posts)).toThrow(/trung-slug/);
    expect(() => getDrafts(drafts, posts)).toThrow(/content\/posts|posts/);
  });

  it('reads no clock', () => {
    // §14 — nothing under `src/site/` may read the clock. A draft's placement
    // is its frontmatter date, not today's.
    const src = readFileSync('src/site/drafts.ts', 'utf8');
    expect(src).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});

describe('the mempool route', () => {
  it('is built, so its nav entry is a real link', () => {
    // routes.ts drives both the nav and this page's existence; flipping the
    // flag without shipping the page is exactly the dead link the nav rule
    // exists to prevent.
    expect(routeById('mempool').built).toBe(true);
    expect(distPages()).toContain('mempool/index.html');
    expect(resolvesIn(DIST, '/mempool')).toBe(true);
  });

  it('ships a drafts directory for an author to write into', () => {
    expect(existsSync('content/drafts')).toBe(true);
    expect(existsSync('content/drafts/.gitkeep'), 'content/drafts is not committed').toBe(true);
  });
});

describe('a mempool holding drafts', () => {
  it('lists every draft, newest first', () => {
    expect(titlesIn(listOf(draftsHtml))).toEqual([NEWER.title, OLDER.title]);
  });

  it('renders no hash, address or value for a draft', () => {
    // §3.6 — a draft is not in the chain, and the page may not imply it is.
    // Scoped to the list: the card's prose names hashes in order to deny them.
    const list = listOf(draftsHtml);
    expect(list).not.toMatch(/0x[0-9a-f]{6}/);
    expect(list).not.toMatch(/giờ nghiên cứu/);
    expect(list, 'a draft was given a gas figure').not.toMatch(/\d+\s*từ/);
    expect(list, 'a draft was stamped as a chain record').not.toMatch(/Sealed|Chưa niêm phong/);
    expect(list, 'a draft was linked as if it had a transaction page').not.toMatch(/href="\/(tx|block|address)/);
  });

  it('says plainly that drafts are not on the chain', () => {
    expect(draftsHtml).toContain('chưa lên chuỗi');
    expect(cardOf(draftsHtml)).toContain('chưa lên chuỗi');
  });

  it('marks each draft with the em dash the open block uses for an absent field', () => {
    for (const line of [...listOf(draftsHtml).matchAll(/<span class="g">([^<]*)<\/span>/g)]) {
      expect(line[1]!).toMatch(/^—/);
    }
  });

  it('keeps a draft out of the chain entirely', () => {
    // The falsehood this route is easiest to ship: a draft appearing as a
    // transaction. Neither the homepage's block cards nor /blocks may name it,
    // and no page may exist for it.
    for (const [page, html] of [['index.html', homeWithDrafts], ['blocks/index.html', blocksWithDrafts]] as const) {
      expect(html, `${page} names a draft as a chain record`).not.toContain(NEWER.title);
      expect(html, `${page} names a draft as a chain record`).not.toContain(OLDER.title);
    }
  });
});

describe('an empty mempool', () => {
  it('says there are no drafts rather than rendering a bare page', () => {
    expect(emptyHtml, 'the empty mempool rendered a draft list').not.toMatch(/<ul class="mem">/);
    expect(cardOf(emptyHtml)).toMatch(/Chưa có bản nháp nào/);
  });

  it('still says what a mempool is', () => {
    expect(emptyHtml).toContain('chưa lên chuỗi');
  });

  it('is the state the live repository ships', () => {
    // Not a substitute for the sandbox: this pins that the shipped build is
    // the empty one, so the assertions above describe what a reader sees today.
    expect(getDrafts()).toEqual([]);
    expect(cardOf(readDist('mempool/index.html'))).toMatch(/Chưa có bản nháp nào/);
  });
});

describe('publishing a draft', () => {
  it('takes it out of the mempool and puts it in the chain', () => {
    const dir = sandboxRepo();
    const drafts = join(dir, 'content/drafts');
    mkdirSync(drafts, { recursive: true });
    const draft = join(drafts, `${NEWER.slug}.md`);
    writeFileSync(draft, draftFile(NEWER.title, NEWER.date, 'Ý tưởng chưa viết xong.'));

    const before = buildSandbox(dir);
    expect(before.status, `sandbox build failed:\n${before.output}`).toBe(0);
    expect(readFileSync(join(dir, 'dist/mempool/index.html'), 'utf8')).toContain(NEWER.title);

    // Publishing is a move: the file leaves `content/drafts/` for
    // `content/posts/`, and `chain:build` hashes it into the open block.
    renameSync(draft, join(dir, 'content/posts', `${NEWER.slug}.md`));
    const chain = chainBuildSandbox(dir, '2026-09-20');
    expect(chain.status, `chain:build failed:\n${chain.output}`).toBe(0);
    expect(pendingIdsIn(dir), 'the published post did not enter the open block').toContain(NEWER.slug);

    const after = buildSandbox(dir);
    expect(after.status, `sandbox build failed:\n${after.output}`).toBe(0);
    const mempool = readFileSync(join(dir, 'dist/mempool/index.html'), 'utf8');
    expect(mempool, 'a published post is still listed as a draft').not.toContain(NEWER.title);
    expect(cardOf(mempool)).toMatch(/Chưa có bản nháp nào/);
    // And it is on the chain now — in the open block, with a page of its own.
    expect(readFileSync(join(dir, 'dist/blocks/index.html'), 'utf8')).toContain(NEWER.title);
    expect(existsSync(join(dir, 'dist/tx', NEWER.slug, 'index.html'))).toBe(true);
  }, 300_000);

  it('fails the build when the draft is copied instead of moved', () => {
    // One file, two places: the author copied the draft into `content/posts/`
    // and left the original behind. Rendering it in both would present the same
    // writing as simultaneously on the chain and not on it.
    const dir = sandboxRepo();
    const drafts = join(dir, 'content/drafts');
    mkdirSync(drafts, { recursive: true });
    const draft = join(drafts, `${NEWER.slug}.md`);
    const post = join(dir, 'content/posts', `${NEWER.slug}.md`);
    writeFileSync(post, draftFile(NEWER.title, NEWER.date, 'Ý tưởng chưa viết xong.'));
    expect(chainBuildSandbox(dir, '2026-09-20').status).toBe(0);

    // Control: published and no longer drafted, the build is clean.
    const clean = buildSandbox(dir);
    expect(clean.status, `control build failed:\n${clean.output}`).toBe(0);

    writeFileSync(draft, draftFile(NEWER.title, NEWER.date, 'Ý tưởng chưa viết xong.'));
    const build = buildSandbox(dir);
    expect(build.status, `the build rendered one post as both a draft and a transaction:\n${build.output}`).not.toBe(0);
    expect(build.output).toContain(NEWER.slug);
    expect(build.output).toMatch(/content\/drafts/);
    expect(build.output).toMatch(/content\/posts/);
  }, 300_000);
});

describe('the mempool styles', () => {
  it('styles the off-chain card and draft list through tokens, never a literal colour', () => {
    // Eleven reader-selectable palettes; a literal would be wrong under ten of
    // them. Scoped to the rules this route added — the whole-file scan lives in
    // pending-render.test.ts.
    const css = readFileSync('src/styles/chain.css', 'utf8');
    const rules = parseRules(css);
    for (const selector of ['.card.offchain', '.mem', '.mem .g', '.stamp.off']) {
      const rule = rules.find((r) => selectorParts(r).includes(selector));
      expect(rule, `${selector} is not a rule in chain.css — the guard is not scanning it`).toBeDefined();
      expect(rule!.body, `${selector} hard-codes a colour`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});
