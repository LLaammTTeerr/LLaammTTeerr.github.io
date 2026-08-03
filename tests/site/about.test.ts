import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAIN_CONFIG } from '../../chain.config';
import { identityAddress } from '../../src/chain/address';
import { senders } from '../../src/site/addresses';
import { postMetaLine, researchHours, shortHash } from '../../src/site/chain-data';
import { parseRules, selectorParts } from './css';
import { DIST, distPages, internalHrefs, readDist, rendered, resolvesIn, rowFor } from './dist';
import { buildSandbox, chainBuildSandbox, sandboxRepo } from './sandbox';

/**
 * `/about` — the author's own address page (§3.7/§6). Read from `dist/`, not
 * from `getProfile`/`senders` directly, on the same reasoning
 * `address-pages.test.ts` gives: a unit test can only prove a function is
 * right, never that the route still calls it.
 *
 * Every expectation about the card is derived from the chain the build read,
 * never written down: the author publishes, and a literal count, title or total
 * here would start failing on the day they do while saying nothing about this
 * page. What the profile's *link* rendering does — no
 * section when there is nothing to show, a link for an entry that declares a
 * url and plain text for one that does not — cannot be exercised against the
 * real `content/profile.md`, which declares three labels and no url at all, so
 * those cases are fixture-driven over a sandboxed copy with its own
 * `content/profile.md`.
 */

const page = () => readDist('about/index.html');

/**
 * Every per-row hours figure a card states, in document order.
 *
 * The lookahead matters: an amended row continues past its hours with
 * `· <a class="amend">đã sửa</a>` (§3.9), so a pattern anchored on the closing
 * `</span>` silently skips exactly the rows an amendment touched — and those
 * are the rows whose figure the total is most likely to get wrong.
 */
function rowHours(card: string): number[] {
  return [...card.matchAll(/· ([\d.]+) giờ(?=[ <])/g)].map((m) => Number(m[1]!));
}

/** The address card, without the nav/layout/bio/links around it. */
function cardOf(html: string): string {
  const m = /<article class="card"[^>]*data-address="[^"]*"[\s\S]*?<\/article>/.exec(html);
  if (m === null) throw new Error('the page has no address card');
  return m[0];
}

/**
 * The author-supplied card — bio and links, §5.1/D18's dashed "Ngoài chuỗi"
 * treatment — or `null` when the profile has nothing to show. `class="card
 * offchain"` (with the space) never matches `cardOf`'s `class="card"[^>]*
 * data-address` pattern, so the two helpers cannot cross-match each other's
 * card by accident.
 */
function offchainCardOf(html: string): string | null {
  const m = /<article class="card offchain"[^>]*>[\s\S]*?<\/article>/.exec(html);
  return m ? m[0] : null;
}

describe('the /about route', () => {
  it('builds a page the nav can link to', () => {
    expect(distPages()).toContain('about/index.html');
    expect(resolvesIn(DIST, '/about')).toBe(true);
  });
});

describe('the author address card', () => {
  it('shows the author address the engine derives', async () => {
    expect(page()).toContain(await identityAddress(CHAIN_CONFIG.authorHandle));
  });

  it('shows the full address, not a middle-truncated one', async () => {
    // §3.1 — this is the address's own detail page, so it prints in full.
    const addr = await identityAddress(CHAIN_CONFIG.authorHandle);
    expect(cardOf(page())).toContain(`<span class="addr">${addr}</span>`);
    expect(cardOf(page()), 'the identity address is middle-truncated on its own page').not.toContain(
      shortHash(addr),
    );
  });

  it("lists the author's transactions", () => {
    // Every post is sent FROM this address, so its history is the whole chain.
    //
    // `senders()`, not `getPosts()`: the card lists the open block's posts too
    // (§3.6), and an amended post is listed under the title its newest
    // amendment declares (§3.9). Reading the sealed originals would demand the
    // superseded title — which is exactly the falsehood the page must not print.
    const posts = senders();
    expect(posts.length, 'the shipped ledger has no posts to check').toBeGreaterThan(0);
    for (const post of posts) expect(page()).toContain(rendered(post.title));
  });

  it('links every listed post to its own transaction page, and every link resolves', () => {
    const card = cardOf(page());
    for (const post of senders()) {
      expect(card, `${post.slug} is not linked from /about`).toContain(
        `<a href="/tx/${post.slug}">${rendered(post.title)}</a>`,
      );
      expect(resolvesIn(DIST, `/tx/${post.slug}`)).toBe(true);
    }
  });

  it('states the same transaction count and total research hours as senders() derives', () => {
    const txs = senders();
    const card = cardOf(page());
    expect(card).toContain(`<dt>Txns</dt><dd><span class="num">${txs.length}</span></dd>`);

    const hours = researchHours(txs.reduce((sum, p) => sum + p.value, 0));
    if (hours === null) {
      expect(card).toContain('<dt>Research</dt><dd>—</dd>');
    } else {
      expect(card).toContain(`<dt>Research</dt><dd><span class="num">${hours}</span> giờ nghiên cứu</dd>`);
    }
  });

  it("states each row's word count and research hours, from the chain's current record", () => {
    // Covered by nothing: replacing `{txMetaLine(tx)}` here and on
    // `/address/[name]` — deleting every per-transaction figure from both
    // surfaces — left 704/704 green, and that same line is where the card
    // contradicted its own Research total after an amendment.
    const card = cardOf(page());
    const posts = senders();
    expect(posts.length, 'the shipped ledger has no posts to check').toBeGreaterThan(0);
    for (const post of posts) {
      const row = rowFor(card, post.slug);
      expect(row, `${post.slug} has no row on /about`).not.toBeNull();
      expect(row!, `${post.slug}'s row states no figures`).toContain(postMetaLine(post));
      // Anchored to the real figures too, so a `postMetaLine` that returned a
      // constant would still have to match the chain. §3.8 puts an em dash
      // where a figure is absent — an undeclared research value, or a word
      // count that could not be re-derived — so the absent case is asserted as
      // the em dash and never as the word `null`.
      expect(row!).toContain(post.gasUsed === null ? '— ·' : `${post.gasUsed} từ`);
      const hours = researchHours(post.value);
      expect(row!).toContain(hours === null ? '· —' : `${hours} giờ`);
    }
  });

  it('adds up: the rows sum to the Research total the card header states', () => {
    const card = cardOf(page());
    const hours = rowHours(card);
    // One figure per row that has one. A post declaring nothing renders `—`
    // (§3.8) and contributes 0 to the total, so it is absent from both sides.
    const declared = senders().filter((p) => researchHours(p.value) !== null);
    expect(declared.length, 'no post on the chain declares any hours to sum').toBeGreaterThan(0);
    expect(hours.length, 'the rows and the chain disagree on who declared hours').toBe(
      declared.length,
    );
    const stated = /<dt>Research<\/dt><dd><span class="num">([\d.]+)<\/span>/.exec(card);
    expect(stated, 'the card states no Research total').not.toBeNull();
    expect(hours.reduce((a, b) => a + b, 0)).toBeCloseTo(Number(stated![1]!), 5);
  });

  it('states first seen and last seen from the committed dates', () => {
    const dates = senders().map((t) => t.date).sort();
    const card = cardOf(page());
    expect(card).toContain(`<dt>First seen</dt><dd>${dates[0]}</dd>`);
    expect(card).toContain(`<dt>Last seen</dt><dd>${dates[dates.length - 1]}</dd>`);
  });
});

describe('the Research total, over an amendment the shipped ledger may not hold', () => {
  /**
   * `/about` summing `Transaction.value` directly is wrong the moment anything
   * is amended (§3.9: `Transaction.value` is fixed at 0 on an amendment, and
   * the current figure lives in the newest amendment's `research`), and the
   * assertion above ("states the same transaction count and total research
   * hours as senders() derives") cannot see it — both sides would be wrong
   * together.
   *
   * So this constructs the chain it needs rather than hoping the committed one
   * has that shape: a `'fixture'` sandbox, whose posts and whose ledger are
   * this test's own, driven through a real `chain:build` over a real edit and
   * a real `astro build`.
   */
  const AMENDED = '2026-06-15-first';
  const ORIGINAL_HOURS = '2.0';
  const AMENDED_HOURS = '9.5';

  it("reflects the post's amended research hours, not its original value", () => {
    const dir = sandboxRepo({ content: 'fixture', chainAt: '2026-08-05' });
    const path = join(dir, 'content/posts', `${AMENDED}.md`);
    const original = readFileSync(path, 'utf8');
    const amended = original.replace(`research: ${ORIGINAL_HOURS}`, `research: ${AMENDED_HOURS}`);
    expect(
      amended,
      `the fixture post has no "research: ${ORIGINAL_HOURS}" for this edit to target`,
    ).not.toBe(original);
    writeFileSync(path, amended);

    // Recorded but not sealed: the resolution must find it in the open block,
    // the same as `getPostContent` and the tag/series address pages do.
    const record = chainBuildSandbox(dir, '2026-08-05');
    expect(record.status, `chain:build failed:\n${record.output}`).toBe(0);

    const build = buildSandbox(dir);
    expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
    const card = cardOf(readFileSync(join(dir, 'dist/about/index.html'), 'utf8'));

    // The amended post's own row carries the new figure and not the old one.
    const row = rowFor(card, AMENDED);
    expect(row, `${AMENDED} has no row on /about`).not.toBeNull();
    expect(row!).toContain(`${AMENDED_HOURS} giờ`);
    expect(row!, 'the row still states the superseded figure').not.toContain(
      `${ORIGINAL_HOURS} giờ`,
    );

    // And the header total is the sum of those rows. A total summing
    // `Transaction.value` would read 2.0 here while the row reads 9.5, so the
    // card would contradict itself — which is the defect this pins.
    const hours = rowHours(card);
    const stated = /<dt>Research<\/dt><dd><span class="num">([\d.]+)<\/span>/.exec(card);
    expect(stated, 'the card states no Research total').not.toBeNull();
    expect(hours).toContain(Number(AMENDED_HOURS));
    expect(hours.reduce((a, b) => a + b, 0)).toBeCloseTo(Number(stated![1]!), 5);

    // The transaction count is untouched: the edit amends a post already
    // there, it does not add another. Counted from the sandbox's own posts.
    const posts = readdirSync(join(dir, 'content/posts')).filter((f) => f.endsWith('.md')).length;
    expect(card).toContain(`<dt>Txns</dt><dd><span class="num">${posts}</span></dd>`);
  }, 300_000);
});

describe('the off-chain marker on the author-supplied half (§5.1/D18)', () => {
  /**
   * `content/profile.md` is off-chain by the author's own decision (D18 in
   * DECISIONS-2026-08-03.md) — nothing hashes it — but `/about` surrounds the
   * bio with a real address and real totals, so unlabelled prose would read
   * as though it carried the same guarantee. The fix reuses the mempool's own
   * vocabulary (`src/pages/mempool.astro`): the dashed `.card.offchain`
   * treatment, the `.stamp.off` "Ngoài chuỗi" badge, and the phrase
   * `chưa lên chuỗi` in an `.off-note`.
   */
  it('says the bio is not on the chain, inside its own card — not as a claim about the whole page', () => {
    const html = page();
    const card = offchainCardOf(html);
    expect(card, 'the real profile has a bio, so /about should render an off-chain card').not.toBeNull();
    expect(card!).toContain('chưa lên chuỗi');
    expect(card!).toContain('Ngoài chuỗi');

    // Scoped, not vacuous: "the page contains the phrase somewhere" would
    // also pass a version that stamped the whole page off-chain, or one that
    // put the notice in the nav. It must sit with the bio specifically.
    const committed = cardOf(html);
    expect(committed, 'the off-chain phrase leaked into the committed address card').not.toContain(
      'chưa lên chuỗi',
    );
    expect(committed, 'the off-chain badge leaked into the committed address card').not.toContain(
      'Ngoài chuỗi',
    );
    const outsideTheCard = html.replace(card!, '');
    expect(outsideTheCard, 'the marker also appears somewhere outside its own card').not.toContain(
      'chưa lên chuỗi',
    );
  });

  it("points at the author's contracts, and does it from the off-chain half", () => {
    // §6 lists "deployed contracts" as part of the author profile. `/contracts`
    // is built and in the nav, but nothing on `/about` reached it, so the one
    // page describing the author did not carry the one thing §6 says it should
    // beside the bio.
    //
    // In the off-chain card and nowhere else, because that is what a project
    // is (§5.1): `content/contracts/` is hashed nowhere, and a link sitting in
    // the committed address card — beside the address, the transaction count
    // and the research total — would read as another figure the chain vouches
    // for. A link and no count: the number of contracts is off-chain data too,
    // and the page at the other end says everything about them, including when
    // there are none.
    const html = page();
    const card = offchainCardOf(html);
    expect(card, 'the real profile has a bio, so /about should render an off-chain card').not.toBeNull();
    expect(card!, '/about does not link /contracts').toContain('href="/contracts"');
    expect(resolvesIn(DIST, '/contracts')).toBe(true);
    expect(
      cardOf(html),
      'the contracts link sits in the committed card, where it reads as chain data',
    ).not.toContain('href="/contracts"');
  });

  it('leaves the committed card reading as chain data — no off-chain badge, no dashed class', () => {
    // The requirement's other half: the contrast comes from labelling the
    // unverified half, not from weakening how the real data presents. If a
    // later change wrapped the whole page in the dashed treatment, or moved
    // the "Ngoài chuỗi" stamp onto the committed card, this catches it.
    const committed = cardOf(page());
    expect(committed).not.toContain('offchain');
    expect(committed).not.toContain('class="stamp off"');
    expect(committed).toContain('<span class="per">Address</span>');
    expect(committed).toContain('<dt>Address</dt><dd><span class="addr">');
    expect(committed).toContain('<dt>Txns</dt><dd><span class="num">');
  });

  it('renders no off-chain card, and no stray marker text, when the profile has nothing to show', () => {
    const dir = sandboxRepo();
    writeFileSync(
      join(dir, 'content/profile.md'),
      ['---', 'handle: lamter', 'name: lamter.eth', 'bio: ""', 'links: []', '---', ''].join('\n'),
    );
    const build = buildSandbox(dir);
    expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
    const html = readFileSync(join(dir, 'dist/about/index.html'), 'utf8');

    expect(offchainCardOf(html), 'an off-chain card rendered with nothing inside it to mark').toBeNull();
    expect(html).not.toContain('chưa lên chuỗi');
    expect(html).not.toContain('Ngoài chuỗi');
    // The committed card is unaffected either way.
    expect(cardOf(html)).toContain('<dt>Txns</dt><dd><span class="num">');
  }, 120_000);
});

describe('the author bio', () => {
  it('renders the profile bio through the markdown pipeline, not raw', () => {
    // content/profile.md's real bio names competitive programming and
    // blockchain; if it ever showed up as literal markdown asterisks or a
    // raw `#` heading this would catch it having gone through no pipeline
    // at all. The stronger, XSS-relevant guarantee (HTML dropped, unsafe
    // URL schemes stripped) is markdown.test.ts's, exercised here only
    // insofar as it is the same renderMarkdown call.
    expect(page()).toMatch(/<div class="bio">[\s\S]*<p>[\s\S]*<\/p>[\s\S]*<\/div>/);
  });

  it('never publishes an email address, on the page or in the source file', () => {
    // The one hard limit: an address visible in this environment but never
    // requested for publication. Checked generically — no real address is
    // written into this test file either.
    const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    expect(readFileSync('content/profile.md', 'utf8')).not.toMatch(EMAIL);
    expect(page()).not.toMatch(EMAIL);
    expect(page()).not.toMatch(/mailto:/i);
  });
});

describe('the /about styles', () => {
  it('styles the bio and the profile links through tokens, never a literal colour', () => {
    const css = readFileSync('src/styles/chain.css', 'utf8');
    const rules = parseRules(css);
    for (const selector of ['.bio a', '.profile-links a']) {
      const rule = rules.find((r) => selectorParts(r).includes(selector));
      expect(rule, `${selector} is not a rule in chain.css`).toBeDefined();
      expect(rule!.body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
      expect(rule!.body).toContain('var(--acc)');
    }
  });
});

describe('link integrity from /about', () => {
  it('leaves no internal link on the page pointing at something never built', () => {
    let checked = 0;
    for (const href of internalHrefs(page())) {
      expect(resolvesIn(DIST, href), `${href} is linked from /about but was never built`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/**
 * The profile's link section, over a sandboxed `content/profile.md` — the
 * real one ships obvious placeholder urls (§6, the content override), so
 * only a fixture can exercise "no links at all" and "one entry with a url,
 * one without" separately.
 */
describe('the profile links section, fixture-driven', () => {
  function withProfile(frontmatter: string[]): string {
    const dir = sandboxRepo();
    writeFileSync(join(dir, 'content/profile.md'), ['---', ...frontmatter, '---', ''].join('\n'));
    const build = buildSandbox(dir);
    expect(build.status, `sandbox build failed:\n${build.output}`).toBe(0);
    return readFileSync(join(dir, 'dist/about/index.html'), 'utf8');
  }

  it('renders no link section when the profile declares none', () => {
    // The failure this guards: shipping placeholder links that go nowhere,
    // on a site whose premise is that what it displays is verifiable.
    const html = withProfile(['handle: lamter', 'name: lamter.eth', 'bio: ""', 'links: []']);
    expect(html).not.toContain('profile-links');
    expect(html).not.toMatch(/href="https?:\/\/example\./);
    expect(html).not.toContain('TODO');
  }, 120_000);

  it('renders a link only for a profile entry that declares a url, and plain text otherwise', () => {
    // §6, and the rule `src/site/routes.ts` already enforces for every
    // internal route: the site never links to what does not exist, so an
    // unbuilt route is rendered as plain text rather than dropped or linked.
    // An external url the author has not filled in is the same claim — and
    // this page shipped three of them (`https://github.com/your-handle` and
    // two more) as live anchors under a heading §6 calls "verified social
    // links".
    const html = withProfile([
      'handle: lamter',
      'name: lamter.eth',
      'bio: ""',
      'links:',
      '  - label: "Có liên kết"',
      '    url: "https://example.test/co-lien-ket"',
      '  - label: "Chưa có liên kết"',
    ]);
    expect(html).toContain('<a href="https://example.test/co-lien-ket">Có liên kết</a>');
    // Named, so the author can see the row is there…
    expect(html).toContain('<span class="unlinked">Chưa có liên kết</span>');
    // …and not clickable, in any shape. An anchor around that label — with
    // any href, including an empty one — is the failure this replaces.
    expect(html, 'a link-less entry was rendered as an anchor').not.toMatch(
      /<a[^>]*>Chưa có liên kết<\/a>/,
    );
  }, 120_000);

  it('ships no profile link whose url is a placeholder, on the page as built', () => {
    // The concrete thing that was wrong: `content/profile.md` carried three
    // `your-handle` urls and they were the only external anchors in the whole
    // build. Read from the real `dist/`, so this is about what ships.
    const anchors = [...page().matchAll(/<a[^>]*href="(https?:\/\/[^"]*)"/g)].map((m) => m[1]!);
    for (const href of anchors) {
      expect(href, `${href} is a placeholder url shipped as a live link`).not.toMatch(
        /your-handle|your-?name|example\.(com|org|net)|USERNAME/i,
      );
    }
    // And the source it comes from carries none either — a later edit that
    // pastes a placeholder back in fails here rather than on the page.
    expect(readFileSync('content/profile.md', 'utf8')).not.toMatch(/your-handle/i);
  });

  it('renders the bio paragraph when the profile declares one, and nothing when it does not', () => {
    const withBio = withProfile(['handle: lamter', 'name: lamter.eth', 'bio: "Một đoạn tiểu sử."', 'links: []']);
    expect(withBio).toContain('<div class="bio"><p>Một đoạn tiểu sử.</p></div>');

    const withoutBio = withProfile(['handle: lamter', 'name: lamter.eth', 'bio: ""', 'links: []']);
    expect(withoutBio).not.toContain('class="bio"');
  }, 120_000);
});
