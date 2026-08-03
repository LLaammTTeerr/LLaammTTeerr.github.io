import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sax from 'sax';
import { DIST, distPages, readDist, rendered } from './dist';
import {
  buildSandbox,
  chainBuildSandbox,
  lockIn,
  sandboxRepo,
  startDevSandbox,
  type DevServer,
} from './sandbox';
import { getPendingPosts, getPostContent, resolvedPosts } from '../../src/site/chain-data';
import { excerptOf, FEED_TITLE, rfc822 } from '../../src/site/feed';
import { ROUTES } from '../../src/site/routes';
import type { Chain, Transaction } from '../../src/chain/types';

/**
 * §6 — `/rss.xml`, the feed.
 *
 * The distinction this file exists to hold: **a feed answers "what is this
 * post", not "what did this transaction record".** `/blocks` and `/tx` are
 * ledger views and show each transaction as recorded; the feed resolves to the
 * governing record, so an amended post appears under its *current* title. That
 * is the one assertion a chain without an amendment cannot make, which is why
 * the sandbox below mines one rather than leaning on the demo corpus — the
 * corpus has an amendment today and `npm run demo:clear` removes it.
 *
 * The XML is **parsed**, never matched. A feed that a reader's aggregator
 * cannot parse is a feed that does not exist, and a regex over `<title>…</title>`
 * cannot tell a well-formed document from one with an unescaped `&` in it —
 * which is exactly the failure the escaping test is for. `sax` in strict mode
 * is a real XML parser and reports the same faults a reader would hit.
 */

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  /** This element's own character data, with child elements' text excluded. */
  text: string;
  children: XmlNode[];
}

interface ParsedXml {
  /** Everything strict-mode sax objected to. A well-formed document has none. */
  errors: string[];
  root: XmlNode;
}

/**
 * A real XML parse in strict mode.
 *
 * `sax.parser(true)` is XML, not HTML: an unescaped `&`, an unescaped `<`, a
 * mismatched close tag or an unclosed root are all reported rather than
 * silently recovered from, which is the whole point of checking here instead
 * of pattern-matching the string. `resume()` after each error keeps parsing so
 * a failure message can name every fault, not only the first.
 */
function parseXml(xml: string): ParsedXml {
  const errors: string[] = [];
  const root: XmlNode = { name: '#document', attrs: {}, text: '', children: [] };
  const stack: XmlNode[] = [root];
  const parser = sax.parser(true, {});

  parser.onerror = (error: Error) => {
    errors.push(error.message.split('\n')[0] ?? error.message);
    parser.resume();
  };
  parser.onopentag = (tag) => {
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(tag.attributes)) attrs[key] = String(value);
    const node: XmlNode = { name: tag.name, attrs, text: '', children: [] };
    stack[stack.length - 1]?.children.push(node);
    stack.push(node);
  };
  parser.onclosetag = () => {
    if (stack.length > 1) stack.pop();
  };
  parser.ontext = (text: string) => {
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += text;
  };
  parser.oncdata = (text: string) => {
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += text;
  };

  parser.write(xml).close();
  const document = root.children[0];
  return { errors, root: document ?? root };
}

/** The feed, parsed, with a failure message that names what sax objected to. */
function feed(xml: string): XmlNode {
  const parsed = parseXml(xml);
  expect(parsed.errors, `the feed is not well-formed xml: ${parsed.errors.join('; ')}`).toEqual([]);
  expect(parsed.root.name).toBe('rss');
  const channel = parsed.root.children.find((c) => c.name === 'channel');
  expect(channel, 'the feed has no <channel>').toBeDefined();
  return channel!;
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** One named child's text, or `''` when the element is absent. */
function textOf(node: XmlNode, name: string): string {
  return node.children.find((c) => c.name === name)?.text ?? '';
}

function itemsIn(channel: XmlNode): XmlNode[] {
  return childrenNamed(channel, 'item');
}

/** Every element in the document, root included, depth-first. */
function everyNode(node: XmlNode): XmlNode[] {
  return [node, ...node.children.flatMap(everyNode)];
}

/**
 * Every url the feed states, from anywhere in the document.
 *
 * `<link>` and `<guid>` carry theirs as text; `<atom:link rel="self">` carries
 * its as an attribute. Namespace declarations (`xmlns:atom`) are deliberately
 * not collected: an identifier is not a url a reader follows, the same
 * distinction `withoutNamespaceUris` draws for HTML.
 */
function urlsIn(channel: XmlNode): string[] {
  const out: string[] = [];
  for (const node of everyNode(channel)) {
    if (node.name === 'link' || node.name === 'guid') out.push(node.text.trim());
    for (const key of ['href', 'url']) {
      const value = node.attrs[key];
      if (value !== undefined) out.push(value);
    }
  }
  return out.filter((u) => u !== '');
}

/** The `/tx/<slug>` an item links to, taken from its `<link>`. */
function slugOf(item: XmlNode): string {
  return new URL(textOf(item, 'link')).pathname.replace(/^.*\/tx\//, '').replace(/\/$/, '');
}

/* ------------------------------------------------------------------ *
 * The configured site
 * ------------------------------------------------------------------ */

/**
 * `site` as `astro.config.mjs` declares it.
 *
 * Read as text rather than imported: `astro.config.mjs` is JavaScript and this
 * tsconfig has no `allowJs`, so a `.ts` test cannot import it. What matters is
 * that the expectation is derived from the config and not written out here —
 * the day the author sets a real domain, this test follows it. The sandbox
 * block below proves the *coupling* by building against a different `site`
 * entirely; this half proves the shipped feed agrees with the shipped config.
 *
 * Normalized through `new URL`, because that is what the route is handed:
 * `context.site` is a `URL`, and `src/site/feed.ts` joins against it. Hostnames
 * are case-insensitive and `new URL` lowercases them, so a config spelled
 * `https://LLaammTTeerr.github.io` — the readable form, matching the repository
 * name — produces a feed spelled `https://llaammtteerr.github.io/`. Comparing
 * the raw config text against those urls would fail on the case alone, which
 * says nothing about whether the feed follows `site`. The trailing slash is
 * still applied by hand, on `baseOf`'s rule in `src/site/feed.ts` — `href`
 * supplies one only when the url carries no path of its own.
 */
function configuredSite(path = 'astro.config.mjs'): string {
  const match = /\bsite:\s*'([^']+)'/.exec(readFileSync(path, 'utf8'));
  if (match === null) throw new Error(`${path} declares no site`);
  const href = new URL(match[1]!).href;
  return href.endsWith('/') ? href : `${href}/`;
}

/** A sandbox's recorded open block, read straight off disk. */
function openBlockIn(dir: string): { transactions: Transaction[] } {
  return JSON.parse(readFileSync(join(dir, 'chain.pending.json'), 'utf8')) as {
    transactions: Transaction[];
  };
}

/** Rewrites a sandbox's `site`, so the feed's urls can be proved to follow it. */
function setSandboxSite(dir: string, site: string): void {
  const path = join(dir, 'astro.config.mjs');
  const source = readFileSync(path, 'utf8');
  const next = source.replace(/\bsite:\s*'[^']+'/, `site: '${site}'`);
  if (next === source) throw new Error('could not rewrite site in the sandbox config');
  writeFileSync(path, next);
}

/* ------------------------------------------------------------------ *
 * The feed this repository ships
 * ------------------------------------------------------------------ */

describe('/rss.xml as the site ships it', () => {
  it('is a file, not a page', () => {
    // `dist/rss.xml/index.html` instead of `dist/rss.xml` would be the silent
    // failure: the route "works" in dev and serves HTML in production.
    expect(existsSync(join(DIST, 'rss.xml'))).toBe(true);
    expect(readDist('rss.xml').startsWith('<?xml')).toBe(true);
  });

  it('is well-formed xml', () => {
    const channel = feed(readDist('rss.xml'));
    expect(itemsIn(channel).length).toBeGreaterThan(0);
  });

  it('lists every post on the chain, and nothing else', () => {
    // Derived from the chain, never a literal: the sealed posts plus the open
    // block's, which have real hashes and real pages and are therefore
    // publishable. Amendments are ledger entries, not writing (§3.9), and carry
    // no slug to link — so the count is posts, not transactions.
    const expected = resolvedPosts().map((p) => p.slug);
    expect(expected.length, 'the chain holds no post to publish').toBeGreaterThan(0);
    const listed = itemsIn(feed(readDist('rss.xml'))).map(slugOf);
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  it('includes the open block, whose posts have real hashes and real pages', () => {
    const pending = getPendingPosts().map((t) => t.slug);
    const listed = itemsIn(feed(readDist('rss.xml'))).map(slugOf);
    for (const slug of pending) {
      expect(listed, `${slug} is in the open block and has a page, but no feed entry`).toContain(
        slug,
      );
    }
  });

  it('orders items newest first', () => {
    const items = itemsIn(feed(readDist('rss.xml')));
    const dates = items.map((i) => Date.parse(textOf(i, 'pubDate')));
    for (const at of dates) expect(Number.isNaN(at), 'an item has no parseable pubDate').toBe(false);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  it('dates each item from the post it describes, never from the build', () => {
    // §14 and the determinism rule together: a `pubDate` taken from the clock
    // would make two builds of one chain differ. Every date in the document is
    // a committed one — which is also why there is no `lastBuildDate`.
    const byDate = new Map(resolvedPosts().map((p) => [p.slug, p.date]));
    const items = itemsIn(feed(readDist('rss.xml')));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const slug = slugOf(item);
      const committed = byDate.get(slug);
      expect(committed, `${slug} has a feed entry but is not on the chain`).toBeDefined();
      expect(Date.parse(textOf(item, 'pubDate'))).toBe(Date.parse(`${committed!}T00:00:00Z`));
    }
    expect(readDist('rss.xml')).not.toContain('lastBuildDate');
  });

  it('uses absolute urls, every one of them under the configured site', () => {
    // A relative url in a feed resolves against the reader's aggregator, not
    // against the site, so it points at nothing. Every url must be absolute and
    // must come from `site`, so the feed becomes correct the moment that value
    // is real.
    const site = configuredSite();
    const urls = urlsIn(feed(readDist('rss.xml')));
    expect(urls.length, 'the feed states no url at all').toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('https://'), `${url} is not absolute`).toBe(true);
      expect(url.startsWith(site), `${url} is not under ${site}`).toBe(true);
    }
  });

  it('states no transaction hash', () => {
    // §3.6 — a pending hash must be marked as unconfirmed wherever it appears,
    // and a feed has nowhere to carry that mark. The feed answers "what is this
    // post"; the hash of the record that says so is the ledger's answer, and it
    // is one click away at `/tx/<slug>`. Printing it here with the same
    // authority as a sealed one is the single most misleading thing this site
    // could do, so the feed states none at all.
    const xml = readDist('rss.xml');
    for (const post of resolvedPosts()) {
      expect(xml, `${post.slug}'s governing hash is in the feed`).not.toContain(post.hash);
      expect(xml, `${post.slug}'s original hash is in the feed`).not.toContain(post.originalHash);
    }
  });

  it('is discoverable from every built page, under the name it calls itself', () => {
    // A feed nothing points at is a feed nobody subscribes to. `/rss.xml` gets
    // no nav entry — `ROUTES` lists sections, and a feed is a file, not a page
    // — so autodiscovery in `<head>` is the whole of how a reader's aggregator
    // finds it. The `title` is pinned to the channel's own, because a browser
    // showing one name while the aggregator shows another is two feeds as far
    // as the reader can tell.
    const pages = distPages();
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(readDist(page), `${page} does not point at the feed`).toContain(
        `<link rel="alternate" type="application/rss+xml" title="${rendered(FEED_TITLE)}" href="/rss.xml">`,
      );
    }
    expect(textOf(feed(readDist('rss.xml')), 'title')).toBe(FEED_TITLE);
    expect(ROUTES.some((r) => r.href === '/rss.xml')).toBe(false);
  });

  it('escapes every title and description it carries', async () => {
    // The general guarantee; the fixture below pins the specific characters.
    // Read back through the parser, so what is compared is what an aggregator
    // would show, not the bytes.
    //
    // The description half is not decoration: this test named both and asserted
    // only titles, so a change that mangled every description on the corpus —
    // or an item that carried the wrong text in the element entirely — left it
    // green under a name saying otherwise. What each item must carry is the
    // excerpt of the body `governing.contentHash` commits to, read back through
    // `getPostContent`, which re-derives that hash and refuses a mismatch.
    const bySlug = new Map(resolvedPosts().map((p) => [p.slug, p.title]));
    let described = 0;
    for (const item of itemsIn(feed(readDist('rss.xml')))) {
      const slug = slugOf(item);
      expect(textOf(item, 'title')).toBe(bySlug.get(slug));
      const { body } = await getPostContent(slug);
      expect(textOf(item, 'description'), `${slug}'s description is not its excerpt`).toBe(
        excerptOf(body),
      );
      if (textOf(item, 'description') !== '') described += 1;
    }
    // Anti-vacuity: `''` equals `''` for a corpus of bodies with no prose in
    // them, and the comparison above would then prove nothing at all.
    expect(described, 'no item carried a description to compare').toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * A chain mined for the two questions the live corpus cannot answer
 * ------------------------------------------------------------------ */

/** A post whose title and body carry both characters XML must escape. */
const XML_SLUG = '2026-06-25-xml';
const XML_TITLE = 'Toán tử & và <T> trong C++';
const XML_BODY = 'Viết `a < b && c` ra thì dễ, đọc lại mới thấy khó.';

/** The fixture post the amendment retitles, and what it was called before. */
const AMENDED_SLUG = '2026-06-15-first';
const ORIGINAL_TITLE = 'Bài viết đầu tiên';
const AMENDED_TITLE = 'Bài viết đầu tiên (viết lại)';

/** Some domain that is emphatically not the one in `astro.config.mjs`. */
const SANDBOX_SITE = 'https://feed-fixture.invalid/';

/**
 * A chain this file mines itself, holding the two things the live corpus
 * cannot be relied on for:
 *
 *  - **an amendment.** `npm run demo:clear` removes the demo corpus's one
 *    amendment, and the suite has to be green either way. A test that "an
 *    amended post shows its current title" is meaningless on a chain with no
 *    amendment — it passes for the wrong reason.
 *  - **a title carrying `&` and `<`.** Asserting escaping against whatever the
 *    author happens to have published today is a test of the corpus, not of the
 *    feed. The fixture post below carries both, in its title and in its body.
 *
 * The clock is inside July, so June seals (the two fixture posts plus the one
 * written here) and July stays open. The second `chain:build` runs after a
 * retitle of a *sealed* post, which is what produces the amendment (§3.9).
 *
 * `site` is rewritten to a different domain before the build, so "every url is
 * under `site`" is a statement about the coupling rather than about a constant
 * that happens to appear in two files.
 */
describe('a chain with an amendment and a title carrying xml syntax', () => {
  let dir = '';
  let xml = '';
  let server: DevServer;

  beforeAll(async () => {
    dir = sandboxRepo({ content: 'fixture' });
    setSandboxSite(dir, SANDBOX_SITE);
    writeFileSync(
      join(dir, 'content/posts', `${XML_SLUG}.md`),
      `---\ntitle: "${XML_TITLE}"\ndate: 2026-06-25\ntags: [cp]\nresearch: 1.0\n---\n\n${XML_BODY}\n`,
    );

    const first = chainBuildSandbox(dir, '2026-07-10');
    if (first.status !== 0) throw new Error(`the sandbox chain:build failed:\n${first.output}`);

    // Retitle a post the run above sealed. §3.9: an edit to a sealed post is
    // recorded as an amendment, and detection is on the full `post/1` hash, so
    // a title-only change is enough.
    const path = join(dir, 'content/posts', `${AMENDED_SLUG}.md`);
    const retitled = readFileSync(path, 'utf8').replace(ORIGINAL_TITLE, AMENDED_TITLE);
    writeFileSync(path, retitled);

    const second = chainBuildSandbox(dir, '2026-07-10');
    if (second.status !== 0) throw new Error(`the amending chain:build failed:\n${second.output}`);

    const built = buildSandbox(dir);
    if (built.status !== 0) throw new Error(`the sandbox build failed:\n${built.output}`);
    xml = readFileSync(join(dir, 'dist/rss.xml'), 'utf8');
    server = await startDevSandbox(dir);
  }, 600_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('mined the chain these assertions need', () => {
    // Anti-vacuity. Without this, an amendment that silently stopped being
    // recorded would turn the title assertion below into a tautology.
    const lock: Chain = lockIn(dir);
    const sealed = lock.blocks.flatMap((b) => b.transactions);
    const open = openBlockIn(dir);
    const all = [...sealed, ...open.transactions];

    expect(
      all.some((t) => t.type === 'amendment' && t.title === AMENDED_TITLE),
      'the sandbox recorded no amendment, so the title assertion would prove nothing',
    ).toBe(true);
    expect(sealed.some((t) => t.slug === XML_SLUG)).toBe(true);
    expect(open.transactions.some((t) => t.type === 'post')).toBe(true);
  });

  it('is well-formed xml', () => {
    expect(itemsIn(feed(xml)).length).toBeGreaterThan(0);
  });

  it('shows an amended post under its current title', () => {
    // The distinction the whole route rests on. A ledger view — `/blocks`,
    // `/tx` — shows each transaction as recorded, under the title that
    // transaction carries. A feed answers "what is this post", so it resolves
    // to the governing record. Reading the raw ledger entry here would print
    // the superseded title.
    const item = itemsIn(feed(xml)).find((i) => slugOf(i) === AMENDED_SLUG);
    expect(item, `no feed entry for ${AMENDED_SLUG}`).toBeDefined();
    expect(textOf(item!, 'title')).toBe(AMENDED_TITLE);
    expect(xml, 'the superseded title is still in the feed').not.toContain(ORIGINAL_TITLE + '<');
  });

  it('escapes a title containing xml syntax', () => {
    // Both halves. The bytes must carry the entities — a document with a bare
    // `&` or `<` in a title is not XML and no aggregator will read it — and the
    // parsed value must be the title exactly, so escaping did not mangle it.
    const item = itemsIn(feed(xml)).find((i) => slugOf(i) === XML_SLUG);
    expect(item, `no feed entry for ${XML_SLUG}`).toBeDefined();
    expect(textOf(item!, 'title')).toBe(XML_TITLE);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml, 'a raw & reached the document').not.toMatch(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/);
  });

  it('escapes a description containing xml syntax', () => {
    const item = itemsIn(feed(xml)).find((i) => slugOf(i) === XML_SLUG);
    const description = textOf(item!, 'description');
    expect(description, 'the item carries no description at all').not.toBe('');
    expect(description).toContain('<');
    expect(description).toContain('&');
  });

  it('builds every url from the configured site, whatever that site is', () => {
    // The strong form of the absolute-url rule: this sandbox's `site` is a
    // different domain from the one the repository ships, so a hard-coded host
    // anywhere in the route fails here and nowhere else.
    const urls = urlsIn(feed(xml));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(SANDBOX_SITE), `${url} does not come from site`).toBe(true);
    }
    // And the host the *repository* ships appears nowhere in a feed built
    // against a different one. Derived from the config rather than written out:
    // this line named `lamter.example`, the placeholder that has since been
    // replaced, so it was about to become an assertion that a string nothing
    // could produce is absent — a check that cannot fail. The point was never
    // that one host in particular is missing; it is that the route reads `site`
    // instead of carrying a domain of its own.
    expect(xml, "the repository's own host is hard-coded somewhere").not.toContain(
      new URL(configuredSite()).hostname,
    );
  });

  it('lists the open block post and no amendment', () => {
    const lock = lockIn(dir);
    const open = openBlockIn(dir);
    const posts = [...lock.blocks.flatMap((b) => b.transactions), ...open.transactions].filter(
      (t) => t.type === 'post',
    );
    const listed = itemsIn(feed(xml)).map(slugOf);
    expect([...listed].sort()).toEqual([...posts.map((t) => t.slug!)].sort());

    const openPost = open.transactions.find((t) => t.type === 'post');
    expect(listed, 'the open block\'s post has no feed entry').toContain(openPost!.slug);
  });

  it('serves the same feed over http, as rss', async () => {
    // `astro dev` is a second pipeline with its own hooks — that is how every
    // image in every post could be a broken icon with 691 tests green
    // (see `startDevSandbox`). A feed asserted only of `dist/` is asserted of
    // half the system, and dev is the mode the author actually writes in.
    const response = await server.get('/rss.xml');
    expect(response.status, `dev did not serve /rss.xml:\n${server.output()}`).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/rss\+xml/);
    expect(await response.text()).toBe(xml);
  }, 60_000);

  it('is byte-identical when the same chain is built twice', () => {
    const again = buildSandbox(dir);
    expect(again.status, `the second build failed:\n${again.output}`).toBe(0);
    expect(readFileSync(join(dir, 'dist/rss.xml'), 'utf8')).toBe(xml);
  }, 600_000);
});

/* ------------------------------------------------------------------ *
 * The two derivations, on their own
 * ------------------------------------------------------------------ */

describe('rfc822', () => {
  it('formats a committed date as the RSS date format, at UTC midnight', () => {
    expect(rfc822('2026-08-02')).toBe('Sun, 02 Aug 2026 00:00:00 GMT');
    expect(rfc822('2026-03-04')).toBe('Wed, 04 Mar 2026 00:00:00 GMT');
    // A leap day, so the weekday cannot come from month-length arithmetic that
    // quietly assumes February has 28 days.
    expect(rfc822('2024-02-29')).toBe('Thu, 29 Feb 2024 00:00:00 GMT');
  });

  it('round-trips through the parser every aggregator uses', () => {
    for (const date of ['2026-01-01', '2026-06-15', '2026-12-31']) {
      expect(Date.parse(rfc822(date))).toBe(Date.parse(`${date}T00:00:00Z`));
    }
  });

  it('refuses anything that is not a committed date', () => {
    expect(() => rfc822('2026-8-2')).toThrow();
    expect(() => rfc822('')).toThrow();
  });
});

describe('excerptOf', () => {
  it('takes the first prose paragraph, as plain text', () => {
    expect(excerptOf('Câu đầu tiên.\n\nCâu thứ hai.')).toBe('Câu đầu tiên.');
  });

  it('unwraps the markdown a reader should not see in a feed', () => {
    expect(excerptOf('Xem **`sort`** ở [đây](https://a.example) và ![sơ đồ](/assets/x.svg).')).toBe(
      'Xem sort ở đây và sơ đồ.',
    );
  });

  it('skips a heading, a fence and a table to reach the prose', () => {
    expect(excerptOf('# Tiêu đề\n\n```cpp\nint main();\n```\n\nĐây mới là văn.')).toBe(
      'Đây mới là văn.',
    );
    expect(excerptOf('| a | b |\n| - | - |\n\nVăn xuôi.')).toBe('Văn xuôi.');
  });

  it('skips a heading in the other spelling markdown accepts', () => {
    // `remark-parse` reads `Tiêu đề` over `=======` as a heading exactly as it
    // reads `# Tiêu đề`, and the post page renders it as one. Only the excerpt
    // rule knew about the `#` spelling, so a post opening this way announced
    // itself to every subscriber as `Tiêu đề =======`.
    expect(excerptOf('Tiêu đề\n=======\n\nVăn xuôi.')).toBe('Văn xuôi.');
    expect(excerptOf('Tiêu đề phụ\n-----------\n\nVăn xuôi.')).toBe('Văn xuôi.');
    // Both in one block, and a heading the prose follows without a blank line.
    expect(excerptOf('Tiêu đề\n===\nVăn xuôi ngay sau.')).toBe('Văn xuôi ngay sau.');
    // And a list is not a heading, however much its second line looks like one.
    expect(excerptOf('- một\n- hai')).toBe('một hai');
  });

  it('skips a display-math block, rather than reading LaTeX out to a reader', () => {
    // `remark-math` is in the pipeline and `$$…$$` renders as a formula on the
    // page. As a description it is raw LaTeX, which is not what the post says.
    expect(excerptOf('$$\\sum_{i=1}^{n} i$$\n\nTổng của n số đầu tiên.')).toBe(
      'Tổng của n số đầu tiên.',
    );
    expect(excerptOf('$$\n\\sum_{i=1}^{n} i\n$$\n\nTổng.')).toBe('Tổng.');
    // Inline math is prose and stays: it sits inside a sentence a reader wants.
    expect(excerptOf('Ta cần $O(n \\log n)$ ở đây.')).toBe('Ta cần $O(n \\log n)$ ở đây.');
  });

  it('collapses the line breaks a body carries and a feed does not want', () => {
    expect(excerptOf('Một dòng\nvà dòng nữa.')).toBe('Một dòng và dòng nữa.');
  });

  it('truncates on a word boundary rather than mid-word', () => {
    const long = `${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}`;
    const cut = excerptOf(long, 90);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(91);
    expect(cut).toBe(`${'a'.repeat(40)} ${'b'.repeat(40)}…`);
  });

  it('is empty for a body with no prose to excerpt, rather than guessing', () => {
    expect(excerptOf('')).toBe('');
    expect(excerptOf('```\nint main();\n```')).toBe('');
  });
});
