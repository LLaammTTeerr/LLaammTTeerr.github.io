import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRules, selectorParts } from './css';
import {
  DIST,
  distPages,
  internalHrefs,
  internalSrcs,
  readDist,
  rendered,
  resolvesIn,
  withoutAnchorHrefs,
  withoutNamespaceUris,
} from './dist';
import { buildSandbox, sandboxRepo } from './sandbox';
import { getContracts } from '../../src/site/contracts';
import { routeById } from '../../src/site/routes';
import { DEMO_CONTRACTS, demoPaths } from '../../scripts/demo-content';
import type { Chain } from '../../src/chain/types';

/**
 * §6 — `/contracts` and `/contract/[name]`: the author's projects, presented as
 * deployed contracts.
 *
 * §5.1 governs both. `content/contracts/` is read at build time and **hashed
 * nowhere** — the same standing as `content/drafts/` and `content/profile.md` —
 * so both routes must say so in the vocabulary the site already has (`chưa lên
 * chuỗi`, the dashed `.card.offchain`, the `.stamp.off` badge), and must never
 * dress a project in a hash, an address or a block it does not have.
 *
 * And "verified" is a word this project cannot use loosely: everywhere else on
 * this site it means *recomputable from a committed hash*, which a GitHub link
 * is not. Nothing here verifies a repository, so nothing here may say one is
 * verified. That is asserted below, not merely reviewed.
 *
 * **`content/contracts/` ships empty**, so a test that read the live directory
 * would prove nothing: "the list holds exactly these two" is unsatisfiable and
 * "the empty state renders" would pass for a page incapable of rendering
 * anything else. Every behavioural assertion here is therefore fixture-driven —
 * a tmpdir for `getContracts`, and a *sandbox copy* of the repository with its
 * own `content/contracts/` for the built pages. What the live repository still
 * owes is *agreement*: whatever `getContracts()` finds there, the shipped
 * `/contracts` must show. That is the last test in the empty block, and it
 * holds whether the author has written a contract or not.
 */

const contractFile = (front: Record<string, string | undefined>, body: string): string => {
  const lines = ['---'];
  for (const [key, value] of Object.entries(front)) {
    if (value !== undefined) lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---', '', body, '');
  return lines.join('\n');
};

/** The one off-chain card a contracts page renders, or `null`. */
function cardOf(html: string): string | null {
  const m = /<article class="card offchain"[\s\S]*?<\/article>/.exec(html);
  return m ? m[0] : null;
}

/**
 * A contract's own fields and body — the card with its explanatory prose taken
 * out.
 *
 * Scoped exactly the way `/mempool`'s draft assertions are: that prose names
 * hashes, gas and blocks in order to *deny* them, and links `/blocks` and `/tx`
 * to say where the verifiable half of this site is. An unscoped `not.toContain`
 * over the whole card would fail on the sentence doing the work.
 */
function contractOf(card: string): string {
  return card.replace(/<p class="off-note">[\s\S]*?<\/p>/, '');
}

/** The contract list, without the card, the prose and the layout around it. */
function listOf(html: string): string {
  const m = /<ul class="cons">[\s\S]*?<\/ul>/.exec(html);
  if (m === null) throw new Error('the page rendered no contract list');
  return m[0];
}

/** Display names in the order the contract list renders them. */
function namesIn(list: string): string[] {
  return [...list.matchAll(/<h2 class="t">(?:<a[^>]*>)?([^<]*)/g)].map((m) => m[1]!);
}

/** The one `<li>` a contract occupies in the list, or `null`. */
function rowFor(list: string, slug: string): string | null {
  for (const m of list.matchAll(/<li>[\s\S]*?<\/li>/g)) {
    if (m[0].includes(`href="/contract/${slug}"`)) return m[0];
  }
  return null;
}

const LINKED = {
  slug: 'may-chuoi-alpha',
  name: 'Máy chuỗi Alpha',
  summary: 'Một engine chuỗi khối nhỏ viết để học.',
  repo: 'https://github.example/lamter/may-chuoi-alpha',
  language: 'TypeScript',
};

const UNLINKED = {
  slug: 'cong-cu-beta',
  name: 'Công cụ Beta',
  summary: 'Bộ công cụ dòng lệnh chưa công bố mã nguồn.',
};

/**
 * A contract whose filename is ordinary Vietnamese prose — a space, an `&` and
 * two diacritics.
 *
 * Contracts are the first content type on this site whose slug is freeform:
 * `content/posts/` carries the `YYYY-MM-DD-` habit and never produced one, so
 * nothing had ever put a slug that needs escaping into a url. `content/contracts/
 * máy chủ mcp.md` is not an exotic filename for this author, and unencoded it
 * renders `href="/contract/máy chủ & mcp"` — a link the browser mangles and this
 * file's own dead-link sweep reports as never built, with a message about a link
 * that looks perfectly fine in the page source.
 */
const FREEFORM = {
  slug: 'máy chủ & mcp',
  name: 'Máy chủ MCP',
  summary: 'Một máy chủ MCP nhỏ, viết cho việc riêng.',
  /**
   * What `/contracts` must link. Written out rather than computed with
   * `encodeURIComponent`, which is the function under test: an expectation
   * derived from the implementation would agree with it however it changed.
   */
  href: '/contract/m%C3%A1y%20ch%E1%BB%A7%20%26%20mcp',
};

/**
 * A body that exercises the markdown pipeline's guarantees at once: raw author
 * HTML is dropped, an unsafe URL scheme is unwrapped to its own text, and an
 * `https` link survives (`src/site/markdown.ts`).
 */
const BODY = [
  'Dự án này **vẫn đang làm**.',
  '',
  '<div class="hop-dong-gia">0xdeadbeefdeadbeef</div>',
  '',
  '[bấm vào đây](javascript:alert(1))',
  '',
  '[tài liệu](https://tai-lieu.example/alpha)',
].join('\n');

let emptyHtml = '';
let emptyBuiltDetailPages = true;
let listHtml = '';
let linkedHtml = '';
let unlinkedHtml = '';
let freeformHtml = '';
let sandboxDist = '';

beforeAll(() => {
  const dir = sandboxRepo({ content: 'fixture', chainAt: '2026-08-05' });
  sandboxDist = join(dir, 'dist');
  const contracts = join(dir, 'content/contracts');
  mkdirSync(contracts, { recursive: true });

  // The empty state first — it is the state this route ships in, and building
  // it before the fixtures exist also serves as the control: a failure below is
  // then the page's behaviour, not a broken sandbox.
  const empty = buildSandbox(dir);
  if (empty.status !== 0) {
    throw new Error(`control build of an empty contracts page failed:\n${empty.output}`);
  }
  emptyHtml = readFileSync(join(dir, 'dist/contracts/index.html'), 'utf8');
  emptyBuiltDetailPages = existsSync(join(dir, 'dist/contract'));

  writeFileSync(
    join(contracts, `${LINKED.slug}.md`),
    contractFile(
      { name: LINKED.name, summary: LINKED.summary, repo: LINKED.repo, language: LINKED.language },
      BODY,
    ),
  );
  writeFileSync(
    join(contracts, `${UNLINKED.slug}.md`),
    // No `repo` and no `language` — the state a project whose source the author
    // has not published is in.
    contractFile({ name: UNLINKED.name, summary: UNLINKED.summary }, 'Chưa có gì để nói thêm.'),
  );
  writeFileSync(
    join(contracts, `${FREEFORM.slug}.md`),
    contractFile({ name: FREEFORM.name, summary: FREEFORM.summary }, 'Ghi chú ngắn.'),
  );

  const built = buildSandbox(dir);
  if (built.status !== 0) throw new Error(`sandbox build with contracts failed:\n${built.output}`);
  listHtml = readFileSync(join(dir, 'dist/contracts/index.html'), 'utf8');
  linkedHtml = readFileSync(join(dir, 'dist/contract', LINKED.slug, 'index.html'), 'utf8');
  unlinkedHtml = readFileSync(join(dir, 'dist/contract', UNLINKED.slug, 'index.html'), 'utf8');
  freeformHtml = readFileSync(join(dir, 'dist/contract', FREEFORM.slug, 'index.html'), 'utf8');
}, 300_000);

describe('getContracts', () => {
  function fixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'contracts-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it('reads the declared fields, and takes the slug from the filename', () => {
    const dir = fixtureDir({
      'cf-mcp.md': contractFile(
        {
          name: 'Máy chủ MCP cho Codeforces',
          summary: 'Tóm tắt.',
          repo: 'https://github.example/lamter/cf-mcp',
          language: 'Rust',
        },
        'Thân bài.',
      ),
    });
    expect(getContracts(dir)).toEqual([
      {
        slug: 'cf-mcp',
        name: 'Máy chủ MCP cho Codeforces',
        summary: 'Tóm tắt.',
        repo: 'https://github.example/lamter/cf-mcp',
        language: 'Rust',
        body: 'Thân bài.',
      },
    ]);
  });

  it('carries no hash, address, block or gas — a contract is not a chain record', () => {
    // §5.1 — nothing hashes `content/contracts/`, so there is no field on a
    // `Contract` that could truthfully carry one. Checked as the whole key set,
    // because a template can only print what the view hands it.
    const dir = fixtureDir({ 'x.md': contractFile({ name: 'X' }, 'thân bài') });
    const contract = getContracts(dir)[0]!;
    expect(Object.keys(contract).sort()).toEqual([
      'body',
      'language',
      'name',
      'repo',
      'slug',
      'summary',
    ]);
    expect(JSON.stringify(contract)).not.toMatch(/0x/);
  });

  it('returns nothing for an empty directory, and for one that is not there', () => {
    // The state this ships in: `content/contracts/` holds nothing but a
    // `.gitkeep`, and an absent directory is not an error either.
    expect(getContracts(fixtureDir({}))).toEqual([]);
    expect(getContracts(join(tmpdir(), 'blogchain-no-such-contracts-dir'))).toEqual([]);
  });

  it('ignores anything that is not a markdown file', () => {
    const dir = fixtureDir({
      '.gitkeep': '',
      'ghi-chu.txt': 'không phải hợp đồng',
      'x.md': contractFile({ name: 'X' }, 'thân bài'),
    });
    expect(getContracts(dir).map((c) => c.slug)).toEqual(['x']);
  });

  it('orders by slug, not by whatever the filesystem enumerated', () => {
    const dir = fixtureDir({
      'c.md': contractFile({ name: 'Ba' }, 'x'),
      'a.md': contractFile({ name: 'Một' }, 'x'),
      'b.md': contractFile({ name: 'Hai' }, 'x'),
    });
    expect(getContracts(dir).map((c) => c.slug)).toEqual(['a', 'b', 'c']);
  });

  it('nulls a repo that is not an https url, rather than handing a template a placeholder', () => {
    // §6's rule for this page, and `/about`'s rule for a profile link before
    // it: the site never links to what does not exist, and a half-filled
    // frontmatter value is not a url. `null` is what makes the template render
    // no anchor at all instead of a dead one.
    const cases: Record<string, string | undefined> = {
      'khong-co.md': undefined,
      'rong.md': '',
      'khoang-trang.md': '   ',
      'chua-dien.md': 'TODO',
      'khong-https.md': 'http://github.example/lamter/x',
      'javascript.md': 'javascript:alert(1)',
      'duong-dan.md': 'github.example/lamter/x',
    };
    const files: Record<string, string> = {};
    for (const [file, repo] of Object.entries(cases)) {
      files[file] = contractFile({ name: file, repo }, 'x');
    }
    for (const contract of getContracts(fixtureDir(files))) {
      expect(contract.repo, `${contract.slug} kept a repo that is not an https url`).toBeNull();
    }

    // Control: a real https url is not nulled by an over-eager guard, and
    // surrounding whitespace is not what makes it one.
    const ok = fixtureDir({
      'that.md': contractFile({ name: 'That', repo: '  https://github.example/lamter/that  ' }, 'x'),
    });
    expect(getContracts(ok)[0]!.repo).toBe('https://github.example/lamter/that');
  });

  it('falls back to the slug for a contract that declares no name, and nulls an absent language', () => {
    const dir = fixtureDir({ 'khong-ten.md': contractFile({}, 'thân bài') });
    const contract = getContracts(dir)[0]!;
    expect(contract.name).toBe('khong-ten');
    expect(contract.summary).toBe('');
    expect(contract.language).toBeNull();
  });

  it('reads no clock', () => {
    // §14 — nothing under `src/site/` may read the clock.
    const src = readFileSync('src/site/contracts.ts', 'utf8');
    expect(src).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});

describe('the contracts route', () => {
  it('is built, so its nav entry is a real link', () => {
    // routes.ts drives both the nav and this page's existence; flipping the
    // flag without shipping the page is exactly the dead link the nav rule
    // exists to prevent, and this project has shipped one that way before.
    expect(routeById('contracts').built).toBe(true);
    expect(distPages()).toContain('contracts/index.html');
    expect(resolvesIn(DIST, '/contracts')).toBe(true);
  });

  it('ships a contracts directory for an author to write into', () => {
    expect(existsSync('content/contracts')).toBe(true);
    expect(existsSync('content/contracts/.gitkeep'), 'content/contracts is not committed').toBe(true);
  });
});

describe('an empty contracts page — the state this ships in', () => {
  it('says there are no contracts rather than rendering a bare page', () => {
    expect(emptyHtml, 'the empty contracts page rendered a list').not.toMatch(/<ul class="cons">/);
    const card = cardOf(emptyHtml);
    expect(card, 'the empty page rendered no off-chain card at all').not.toBeNull();
    expect(card!).toMatch(/Chưa có hợp đồng nào/);
  });

  it('still says what a contract is here, and that it is not on the chain', () => {
    expect(cardOf(emptyHtml)!).toContain('chưa lên chuỗi');
    expect(cardOf(emptyHtml)!).toContain('Ngoài chuỗi');
  });

  it('builds no detail page at all when there is no contract', () => {
    expect(emptyBuiltDetailPages, 'an empty content/contracts/ still produced /contract pages').toBe(
      false,
    );
    // Anti-vacuity: the same sandbox does produce them once contracts exist, so
    // the assertion above is about the empty input and not about a sandbox that
    // never builds this route.
    expect(distPages(sandboxDist).some((p) => p.startsWith('contract/'))).toBe(true);
  });

  it('is what the live repository ships, whatever it holds', () => {
    // Not a substitute for the sandbox: this pins that the shipped build says
    // the same thing about `content/contracts/` that `getContracts()` does, so
    // the assertions above describe what a reader actually sees today. Stated
    // as "the live contracts page is empty" it would be a fact about the
    // author's projects — true until the day they write one.
    const contracts = getContracts();
    const card = cardOf(readDist('contracts/index.html'));
    expect(card, 'the shipped /contracts renders no off-chain card').not.toBeNull();
    if (contracts.length === 0) {
      expect(card!).toMatch(/Chưa có hợp đồng nào/);
      expect(card!, 'the empty contracts page rendered a list').not.toMatch(/<ul class="cons">/);
      return;
    }
    expect(card!, 'the shipped page denies contracts that are on disk').not.toMatch(
      /Chưa có hợp đồng nào/,
    );
    expect(namesIn(listOf(card!))).toEqual(contracts.map((c) => rendered(c.name)));
    for (const contract of contracts) {
      expect(
        resolvesIn(DIST, `/contract/${contract.slug}`),
        `/contract/${contract.slug} was never built`,
      ).toBe(true);
    }
  });
});

describe('a contracts page holding contracts', () => {
  it('lists every contract, each linking to its own page', () => {
    const list = listOf(listHtml);
    expect(namesIn(list)).toEqual([
      rendered(UNLINKED.name),
      rendered(LINKED.name),
      rendered(FREEFORM.name),
    ]);
    for (const slug of [LINKED.slug, UNLINKED.slug]) {
      expect(rowFor(list, slug), `${slug} has no row on /contracts`).not.toBeNull();
      expect(resolvesIn(sandboxDist, `/contract/${slug}`)).toBe(true);
    }
  });

  it('percent-encodes a slug that is prose, and the encoded link lands on the page', () => {
    // `getContracts` takes the slug from the filename and validates nothing —
    // deliberately, since a contract is a file the author names, not a record
    // with a canonical form. That makes the url the escaping boundary, and the
    // page is what has to encode.
    const list = listOf(listHtml);
    expect(list, `the list does not link ${FREEFORM.href}`).toContain(`href="${FREEFORM.href}"`);
    expect(list, 'an unencoded slug reached an href').not.toContain('href="/contract/máy');
    // Encoded *and* correct: the encoded url has to name the page the build
    // actually wrote, or the encoding merely moved the dead link.
    expect(resolvesIn(sandboxDist, FREEFORM.href)).toBe(true);
    expect(existsSync(join(sandboxDist, 'contract', FREEFORM.slug, 'index.html'))).toBe(true);
    expect(freeformHtml).toContain(rendered(FREEFORM.name));
  });

  it('renders no hash, address, block or gas for a contract', () => {
    // §5.1 — nothing hashes `content/contracts/`, and the page may not imply
    // otherwise. Scoped to the list: the card's prose names hashes in order to
    // deny them.
    const list = listOf(listHtml);
    expect(list).not.toMatch(/0x[0-9a-f]{6}/);
    expect(list, 'a contract was given a gas figure').not.toMatch(/\d+\s*từ/);
    expect(list, 'a contract was stamped as a chain record').not.toMatch(/Sealed|Chưa niêm phong/);
    expect(list, 'a contract was linked as if it had a transaction').not.toMatch(
      /href="\/(tx|block|address|asset)/,
    );
  });

  it('links the source of a contract that declares a repo, and nothing for one that does not', () => {
    const list = listOf(listHtml);
    expect(rowFor(list, LINKED.slug)!).toContain(`href="${LINKED.repo}"`);
    expect(
      rowFor(list, UNLINKED.slug)!,
      'a contract with no repo was given a link anyway',
    ).not.toMatch(/href="https?:/);
  });
});

describe("a contract's own page", () => {
  it('renders the body through the markdown pipeline', () => {
    expect(linkedHtml).toContain('<strong>vẫn đang làm</strong>');
  });

  it('drops author HTML, exactly as a post body does', () => {
    // `src/site/markdown.ts` runs without `allowDangerousHtml`. A project page
    // is author prose like the bio on `/about` and gets the same treatment —
    // markup that could forge a hash or an address is the specific hazard here.
    expect(linkedHtml, 'raw author HTML reached the page').not.toContain('hop-dong-gia');
    expect(linkedHtml, 'a forged hash reached the page').not.toContain('0xdeadbeefdeadbeef');
  });

  it('keeps an https link and unwraps an unsafe scheme to its own text', () => {
    expect(linkedHtml).toContain('href="https://tai-lieu.example/alpha"');
    expect(linkedHtml, 'a javascript: url survived in the body').not.toMatch(/javascript:/i);
    // Unwrapped, not deleted: the author's words stay on the page.
    expect(linkedHtml).toContain('bấm vào đây');
  });

  it('marks the contract off-chain in the card that holds the contract itself', () => {
    // §5.1's requirement, and the reason it is scoped: "the page says
    // `chưa lên chuỗi` somewhere" is also satisfied by a notice in the nav, in
    // the `<head>`, or under a heading three cards away from the body it is
    // about. It has to sit with the content.
    const card = cardOf(linkedHtml);
    expect(card, 'the contract page renders no off-chain card').not.toBeNull();
    expect(card!).toContain('chưa lên chuỗi');
    expect(card!).toContain('Ngoài chuỗi');
    expect(card!, "the contract's body is outside the card that marks it").toContain(
      '<strong>vẫn đang làm</strong>',
    );

    const outsideTheCard = linkedHtml.replace(card!, '');
    expect(outsideTheCard, 'the marker also appears somewhere outside its own card').not.toContain(
      'chưa lên chuỗi',
    );
  });

  it('never says a contract is verified', () => {
    // The word this project cannot use loosely. Everywhere else on this site
    // "verified" means *recomputable from a committed hash*; a GitHub link is a
    // pointer to a repository that could change tomorrow, and nothing on this
    // page can check it. §6's phrase "verified contracts" is borrowed explorer
    // vocabulary, not a claim this build is able to make.
    for (const [name, html] of [
      ['/contracts', listHtml],
      [`/contract/${LINKED.slug}`, linkedHtml],
      [`/contract/${UNLINKED.slug}`, unlinkedHtml],
    ] as const) {
      expect(html, `${name} calls a contract verified`).not.toMatch(/\bverified\b/i);
      // Every spelling of the claim this site has a word for, not only the one
      // spelling it happens not to use: `xác minh` was the whole list, and
      // `đã kiểm chứng` and `đã xác thực` — both of which appear elsewhere on
      // this site — would have walked straight past it. The negations the pages
      // *do* carry (`không kiểm chứng được`) are unaffected: what is rejected is
      // the affirmative `đã …`, which is the claim.
      expect(html, `${name} claims a contract has been verified`).not.toMatch(
        /đã (được )?(xác minh|xác thực|kiểm chứng)/i,
      );
    }
    // And it says the opposite, where a reader meets the link: this site cannot
    // check what is at the other end of it.
    expect(cardOf(linkedHtml)!).toContain('không kiểm chứng được');
  });

  it('renders no hash, address or chain link for a contract', () => {
    for (const html of [linkedHtml, unlinkedHtml]) {
      const fields = contractOf(cardOf(html)!);
      expect(fields).not.toMatch(/0x[0-9a-f]{6}/);
      expect(fields, 'a contract was given a hash field').not.toMatch(/<span class="hash">/);
      expect(fields, 'a contract was given an address').not.toMatch(/<span class="addr">/);
      expect(fields, 'a contract was given a gas figure').not.toMatch(/\d+\s*từ/);
      expect(fields, 'a contract was linked into the chain as a record of its own').not.toMatch(
        /href="\/(tx|block|address|asset)/,
      );
      // Anti-vacuity: the scoping helper must leave the contract itself behind,
      // or every assertion above is about an empty string.
      expect(fields).toContain('<dl class="meta">');
    }
  });

  it('renders no source link for a contract that declares no repo', () => {
    const card = cardOf(unlinkedHtml)!;
    expect(card, 'a contract with no repo was given a link anyway').not.toMatch(/href="https?:/);
    // Named, not hidden: the row is still there, saying there is no source to
    // link — the same em dash every field this site cannot fill in gets.
    expect(card).toContain('<dt>Source</dt><dd>—</dd>');
  });

  it('links the source of a contract that declares one, and names where it goes', () => {
    const card = cardOf(linkedHtml)!;
    expect(card).toContain(`<a href="${LINKED.repo}"`);
    // The link text is the destination, not "source": this is an external link
    // the site cannot vouch for, and a reader should see where it points before
    // following it.
    expect(card).toContain(`>${LINKED.repo.replace('https://', '')}</a>`);
  });

  it('shows that destination without a scheme, so §9’s guard stays strict', () => {
    // Printing the url in full as visible link *text* shipped a red
    // `no built page references an absolute http(s) url`
    // (tests/site/dist-output.test.ts): that guard rejects any `https?://`
    // substring in a built page and excuses the `href` attribute alone, on
    // purpose. The fix was the page, not the guard — widening the exclusion to
    // document text would excuse nothing real and hide the next `<img src>`.
    for (const html of [listHtml, linkedHtml, unlinkedHtml]) {
      expect(
        withoutAnchorHrefs(withoutNamespaceUris(html)),
        'a contracts page carries an absolute http(s) url outside an href',
      ).not.toMatch(/https?:\/\//);
    }
    // Anti-vacuity: there really is an external url on the page to be excused.
    expect(linkedHtml).toContain(`href="${LINKED.repo}"`);
  });

  it('leaves no internal link or src on either page pointing at something never built', () => {
    let checked = 0;
    for (const [name, html] of [
      ['/contracts', listHtml],
      [`/contract/${LINKED.slug}`, linkedHtml],
      [`/contract/${UNLINKED.slug}`, unlinkedHtml],
      [FREEFORM.href, freeformHtml],
    ] as const) {
      const refs = [...internalHrefs(html), ...internalSrcs(html)];
      checked += refs.length;
      for (const ref of refs) {
        expect(
          resolvesIn(sandboxDist, ref),
          `${ref} is referenced by ${name} but was never built`,
        ).toBe(true);
      }
    }
    expect(checked, 'no page emitted an internal reference at all').toBeGreaterThan(0);
  });
});

describe('the demo corpus', () => {
  it('names every demo contract among the paths demo:clear removes', () => {
    // The demo corpus exists so these pages can be previewed at realistic
    // density, and `npm run demo:clear` must take it away whole — a demo
    // contract left behind on disk is indistinguishable from one the author
    // wrote, and would render as a real project.
    expect(DEMO_CONTRACTS.length).toBeGreaterThan(0);
    for (const contract of DEMO_CONTRACTS) {
      expect(demoPaths()).toContain(`content/contracts/${contract.slug}.md`);
    }
  });

  it('gives every demo contract an obviously placeholder repo, or none at all', () => {
    // `content/profile.md` ships link labels with no url rather than
    // `https://github.com/your-handle`, and `astro.config.mjs` uses the
    // reserved `.example` TLD for its placeholder origin. A demo repo url that
    // looked real would be a link into someone else's repository.
    for (const contract of DEMO_CONTRACTS) {
      if (contract.repo === undefined) continue;
      expect(contract.repo, `${contract.slug} points at a real code host`).not.toMatch(
        /https?:\/\/(www\.)?(github|gitlab|codeberg|bitbucket)\.(com|org|io)\b/i,
      );
      expect(contract.repo, `${contract.repo} is not an obviously placeholder url`).toMatch(
        /^https:\/\/[^/]*\.example(\/|$)/,
      );
    }
    // Both halves of the rule are actually exercised by the corpus: one demo
    // contract links a placeholder source and one declares none, so the demo
    // previews the linked and the unlinked rendering rather than only one.
    expect(DEMO_CONTRACTS.some((c) => c.repo !== undefined)).toBe(true);
    expect(DEMO_CONTRACTS.some((c) => c.repo === undefined)).toBe(true);
  });

  it('keeps every demo contract off the chain', () => {
    // §5.1 — `content/contracts/` is hashed nowhere. Asserted against the
    // committed ledger for the demo slugs whether or not the corpus is seeded
    // right now, so this cannot pass by there being nothing on disk.
    //
    // Structurally, against what a transaction actually *is*, and not as a
    // substring of the file. A contract can only reach the chain by becoming a
    // transaction, and a transaction names a contract by carrying its slug —
    // whereas `not.toContain('blogchain')` goes red the day the author writes a
    // post titled "Blogchain", under a failure message saying a contract
    // reached the chain. A test that cries wolf about the one guarantee this
    // page rests on is worse than no test.
    const ledger = JSON.parse(readFileSync('chain.lock.json', 'utf8')) as Chain;
    const recorded = ledger.blocks.flatMap((b) => b.transactions);
    expect(recorded.length, 'the committed ledger holds no transaction to check').toBeGreaterThan(0);
    const slugs = new Set(recorded.map((t) => t.slug ?? ''));
    for (const contract of [...DEMO_CONTRACTS, ...getContracts()]) {
      expect(slugs.has(contract.slug), `${contract.slug} reached the chain`).toBe(false);
    }
  });
});

describe('the contracts styles', () => {
  it('styles the contract list through tokens, never a literal colour', () => {
    // Eleven reader-selectable palettes; a literal would be wrong under ten of
    // them. Scoped to the rules this route added — the whole-file scan lives in
    // pending-render.test.ts.
    const css = readFileSync('src/styles/chain.css', 'utf8');
    const rules = parseRules(css);
    for (const selector of ['.cons', '.cons .t', '.cons .s', '.cons .g']) {
      const rule = rules.find((r) => selectorParts(r).includes(selector));
      expect(rule, `${selector} is not a rule in chain.css — the guard is not scanning it`).toBeDefined();
      expect(rule!.body, `${selector} hard-codes a colour`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it("reuses the mempool's off-chain treatment rather than inventing a second one", () => {
    // §5.1 says to use the vocabulary the site already has. Both pages reach
    // for `.card.offchain`, `.stamp.off` and `.off-note`, defined once in
    // chain.css for the mempool and reused by `/about`.
    for (const page of ['src/pages/contracts.astro', 'src/pages/contract/[name].astro']) {
      const src = readFileSync(page, 'utf8');
      expect(src, `${page} does not use the off-chain card`).toContain('class="card offchain"');
      expect(src, `${page} does not use the off-chain stamp`).toContain('class="stamp off"');
      expect(src, `${page} does not use the off-chain note`).toContain('class="off-note"');
    }
  });
});
