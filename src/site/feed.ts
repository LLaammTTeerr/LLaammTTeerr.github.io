import { CHAIN_CONFIG } from '../../chain.config';
import { byCodepoint } from '../chain/seal';
import { getPostContent, resolvedPosts, type ResolvedPost } from './chain-data';

/**
 * §6 — `/rss.xml`, the feed.
 *
 * **A feed answers "what is this post", not "what did this transaction
 * record".** That single sentence decides everything in this file. `/blocks`
 * and `/block/<height>` are *ledger* views: they show each transaction as it
 * was sealed, under the title that transaction carries, beside its own hash. A
 * feed is the other kind of surface, the same kind as `/address/<name>`,
 * `/about` and `/tx/<slug>` — so it takes `ResolvedPost` (see the long note on
 * that type in `chain-data.ts`), and an amended post appears under its
 * **current** title, not the superseded one the original transaction records.
 *
 * There is no second resolution here. `resolvedPosts()` is the one walk, and a
 * raw ledger entry cannot satisfy the type this module reads, which is what
 * makes "the feed shows current titles" a fact the compiler checks rather than
 * a rule someone remembered.
 *
 * Reads no clock, at all. `pubDate` is the post's committed date, and there is
 * deliberately no `lastBuildDate`: a build-time field would make two builds of
 * one unchanged chain differ, and it would be the only value in the document
 * nothing on the chain vouches for.
 */

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Text, as XML character data.
 *
 * A title containing `&` or `<` is not exotic — `Toán tử & và <T>` is an
 * ordinary thing for this author to write — and one of them reaching the
 * document raw does not produce a slightly wrong feed, it produces a document
 * no aggregator will parse at all: every subscriber's reader silently stops
 * updating. So this is applied to every interpolated value without exception,
 * on the model of `rendered()` in the test helpers.
 *
 * `&#39;` rather than `&apos;`: both are legal XML, but `&apos;` is the one
 * entity of the five that HTML 4 never defined, and feed content passes through
 * a great deal of software that is vague about which grammar it is in.
 *
 * The control-character strip is separate and comes first. `&#x0;` is *not* a
 * legal escape — XML 1.0 has no way to represent those characters at all, so
 * the only correct handling is to drop them. Tab, newline and carriage return
 * are the three that are legal and are kept.
 */
function xmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/** One element, escaped, or the empty string when there is nothing to say. */
function element(name: string, value: string, attrs = ''): string {
  if (value === '') return '';
  return `<${name}${attrs}>${xmlText(value)}</${name}>`;
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * A committed `YYYY-MM-DD` as the date format RSS 2.0 requires (RFC 822, in
 * the four-digit-year form RFC 2822 settled on).
 *
 * Pure arithmetic on the recorded string — the same rule `sealsOn` follows in
 * `chain-data.ts`. `Date.UTC` is used to *derive the weekday*, which RFC 822
 * demands and a date string does not carry; nothing here consults the clock, so
 * two builds of one chain produce the same bytes.
 *
 * Midnight UTC, not a local time: the chain records a date and no time, and
 * inventing an hour would put the post on the wrong day for readers in half the
 * world's time zones.
 *
 * Throws rather than emitting a date it could not derive. Every caller's input
 * comes from `parsePost`, which already refuses anything that is not
 * `YYYY-MM-DD`, so this can only fire on a ledger written by something else —
 * and a feed carrying `Invalid Date` is worse than a build that stops.
 */
export function rfc822(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    throw new Error(`"${date}" is not a committed date (YYYY-MM-DD), so it has no pubDate`);
  }
  const [, year = '', month = '', day = ''] = match;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // `Date.UTC(2026, 1, 30)` silently rolls into March. A date that does not
  // survive the round trip is not a date this feed may state.
  if (at.getUTCMonth() !== Number(month) - 1 || at.getUTCDate() !== Number(day)) {
    throw new Error(`"${date}" is not a real calendar date`);
  }
  return `${WEEKDAYS[at.getUTCDay()]!}, ${day} ${MONTHS[Number(month) - 1]!} ${year} 00:00:00 GMT`;
}

/* ------------------------------------------------------------------ *
 * Descriptions
 * ------------------------------------------------------------------ */

/** How much of a post's opening an item's description carries. */
const MAX_EXCERPT = 280;

/**
 * Inline markdown, as the plain text a feed reader should show.
 *
 * Deliberately not the rendering pipeline (`markdown.ts`): that produces the
 * post *page* — KaTeX's dual HTML/MathML trees, Shiki's `var(--shiki-*)` spans,
 * `/assets/…` image sources that resolve against the reader's aggregator rather
 * than against this site. None of that belongs in a one-line description, and
 * pushing it through would make the feed depend on the theme.
 *
 * Order matters in two places. Images are unwrapped before links, or the link
 * rule matches the `[alt](src)` inside an image and leaves a stray `!`. Code
 * spans are unwrapped before emphasis, so `` **`sort`** `` loses both layers.
 *
 * The `_` rules are bounded by word edges: `snake_case_name` is prose here, not
 * emphasis, and an unbounded rule eats the underscores out of the middle of it.
 */
function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)__([^_]+)__(?!\w)/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/^[ \t]*[>*+-][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts at a word boundary, so a description never ends mid-word. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  const kept = boundary > 0 ? cut.slice(0, boundary) : cut;
  return `${kept.replace(/[\s.,;:—–-]+$/, '')}…`;
}

/**
 * §3.1 — an item's description, derived from the **committed body**: the first
 * paragraph of prose, as plain text.
 *
 * *Why not `summary`.* The frontmatter carries an optional `summary`, and it is
 * parsed (`parsePost`) but **hashed nowhere** — it is in no canonical form and
 * no transaction hash covers it. That alone would not disqualify it, since a
 * feed description is not chain-attested and nothing here claims otherwise. Two
 * other things did. It is present on one post in fourteen, so a feed built on it
 * is a list of bare titles for everything else; and it puts two kinds of text —
 * one an author's blurb, one derived from bytes the chain vouches for — into one
 * element with nothing distinguishing them.
 *
 * What is used instead comes from the body `contentHash` commits to, read
 * through `getPostContent`, which re-derives that hash from disk and refuses a
 * mismatch. So a description cannot silently disagree with the post it
 * describes: the build stops first. It is still an *excerpt* — lossy, and not
 * something a reader can verify by hashing — which is exactly why it lives in a
 * feed description and appears on no page.
 *
 * A body with no prose to excerpt yields `''`, and the item then carries no
 * description at all rather than a guessed one.
 */
export function excerptOf(body: string, max: number = MAX_EXCERPT): string {
  for (const block of body.split(/\n[ \t]*\n/)) {
    const trimmed = block.trim();
    // A heading, a fenced code block, a table or a raw HTML block is not the
    // sentence that tells a reader what the post is about.
    if (trimmed === '' || /^(#|```|~~~|\||<)/.test(trimmed)) continue;
    const text = plainText(trimmed);
    if (text === '') continue;
    return truncate(text, max);
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

/** §9 — the feed is the blog, so its channel prose is Vietnamese, not chrome. */
const CHANNEL_DESCRIPTION = 'Blog của lamter, hiển thị như một trình duyệt blockchain.';

/**
 * What the feed calls itself.
 *
 * Exported because `Base.astro`'s autodiscovery `<link rel="alternate">` names
 * it too, and a reader whose aggregator shows one name while the browser's feed
 * affordance shows another has been given two feeds to wonder about. One
 * constant, on the model of `ROUTES` being the one list the nav renders from.
 */
export const FEED_TITLE = `Blogchain — ${CHAIN_CONFIG.authorName}`;

/**
 * The configured `site`, guaranteed to end in `/`.
 *
 * `new URL('tx/x', 'https://a.example/blog')` is `https://a.example/tx/x`: URL
 * resolution treats the last path segment as a file and replaces it, so a
 * `site` deployed under a path would silently lose that path from every url in
 * the feed. A trailing slash is what makes the join keep it.
 */
function baseOf(site: URL): URL {
  return site.href.endsWith('/') ? site : new URL(`${site.href}/`);
}

/** An absolute url for a site-relative path. Never built by concatenation. */
function absolute(base: URL, path: string): string {
  return new URL(path, base).href;
}

/**
 * Newest first (§9 — the chain reads backwards into history), by the post's
 * committed date.
 *
 * `resolvedPosts()` hands back the sealed posts in date order followed by the
 * open block's in recorded order, so the two halves have to be merged rather
 * than concatenated: an open-block post is newer than everything sealed only
 * because that is how the chain has run so far, not because anything enforces
 * it. The slug is the tiebreak, so two posts sharing a date have a fixed order.
 *
 * `byCodepoint` and not `localeCompare`, which is what this comment used to
 * claim was enough. `localeCompare` with no locale argument resolves against
 * the host's ambient ICU collation, so the order depends on the machine:
 * measured, `'…-ä'.localeCompare('…-z')` is -1 under `en_US.UTF-8` and
 * `vi_VN.UTF-8` and **+1** under `sv_SE.UTF-8`. Two posts sharing a date whose
 * slugs differ at such a character would swap places in `dist/rss.xml` when the
 * site was built on someone else's machine — the same build, from the same
 * chain, producing different bytes. The engine has always known this (see the
 * note on `byCodepoint` in `src/chain/seal.ts`, where the same mistake would
 * have changed a Merkle root); this is that rule reaching the feed.
 */
function newestFirst(a: ResolvedPost, b: ResolvedPost): number {
  return byCodepoint(b.date, a.date) || byCodepoint(b.slug, a.slug);
}

async function itemFor(post: ResolvedPost, base: URL): Promise<string> {
  const link = absolute(base, `tx/${post.slug}`);
  const { body } = await getPostContent(post.slug);
  const parts = [
    // The **governing** record's title — the current one. Reading `tx.title`
    // here is the defect this whole module is shaped to prevent.
    element('title', post.title),
    element('link', link),
    // `isPermaLink="true"`: the item's own canonical url. A slug is the post's
    // filename and never changes — a reused filename carrying a different date
    // is a build error (§3.9) — so this is stable across amendments, which is
    // what a guid has to be. The governing hash is *not* stable across them,
    // and an aggregator keyed on it would re-announce a post every time the
    // author fixed a typo.
    element('guid', link, ' isPermaLink="true"'),
    element('pubDate', rfc822(post.date)),
    element('description', excerptOf(body)),
    // The governing record's tags — what the post is filed under *now*. Not
    // `publishedTags`, which is the address graph's view (§3.7/§3.9) and is
    // deliberately frozen at original publication.
    ...post.tags.map((tag) => element('category', tag)),
  ];
  return `    <item>\n${parts.filter((p) => p !== '').map((p) => `      ${p}`).join('\n')}\n    </item>`;
}

/**
 * The whole feed, as bytes a reader's aggregator will accept.
 *
 * `site` is passed in rather than read here, because `src/site/` modules derive
 * from the ledger and this one value comes from `astro.config.mjs`. Every url
 * in the document is built from it — there is no host literal anywhere in this
 * file — so the feed becomes correct the moment that config value is a real
 * domain, and is wrong in exactly one, obvious, uniform way until then.
 *
 * No transaction hash appears in the document. §3.6 requires a pending hash to
 * be marked unconfirmed wherever it is shown, and a feed item has nowhere to
 * carry that mark; the open block's posts are published here because they have
 * real pages and real urls, and their hashes stay at `/tx/<slug>`, where the
 * confirmation state is shown beside them.
 */
export async function feedXml(site: URL): Promise<string> {
  const base = baseOf(site);
  const posts = [...resolvedPosts()].sort(newestFirst);
  const items = await Promise.all(posts.map((post) => itemFor(post, base)));

  const channel = [
    element('title', FEED_TITLE),
    element('link', absolute(base, '')),
    element('description', CHANNEL_DESCRIPTION),
    element('language', 'vi'),
    // The feed's own address, which is how an aggregator that was handed the
    // document by some other route can find its way back to the source.
    `<atom:link href="${xmlText(absolute(base, 'rss.xml'))}" rel="self" type="application/rss+xml" />`,
    // The channel's date is the newest post's, never the build's — see the
    // module note on `lastBuildDate`.
    posts[0] === undefined ? '' : element('pubDate', rfc822(posts[0].date)),
  ];

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    ...channel.filter((line) => line !== '').map((line) => `    ${line}`),
    ...items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}
