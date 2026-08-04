import type { SearchAddress, SearchIndex, SearchPost } from './search-index';

/**
 * §6/§8 — what a typed or pasted query turns into.
 *
 * This module is the search box's whole mind, and it is deliberately separate
 * from `search-index.ts`, which *builds* the document. The reason is not
 * tidiness: `search-index.ts` imports `chain-data.ts`, which reads
 * `chain.lock.json` off disk through `node:fs`, so a client script that
 * imported anything from it by value would drag the ledger reader into a bundle
 * a reader downloads. Everything here is a pure function of a parsed index and
 * a string — no filesystem, no clock (§14), no module state — so the same code
 * runs in a test at build time and in the reader's browser over the fetched
 * document.
 *
 * `resolveIdentifier` lives here for that reason and is re-exported from
 * `search-index.ts`, which is where its contract was written and where the
 * index's own tests read it from.
 *
 * **The index is the authority on what may be linked.** A post entry carries
 * the tags the chain files it under; it does not carry a page for them. §3.9
 * lets an amendment add a tag after the block that would have registered its
 * address was sealed, so `addresses` can be missing a name that `posts[].tags`
 * contains. Every href this module can emit therefore comes from
 * `index.addresses`, from a post's own slug, or from `index.blocks` — never
 * from a tag string.
 */

/** `0x` + 64 hex — a transaction hash, in whatever case it was pasted. */
const TX_HASH = /^0x[0-9a-f]{64}$/i;
/** §3.7 — `0x` + 40 hex, an address. */
const ADDRESS = /^0x[0-9a-f]{40}$/i;
/** A block height, with the `#` a reader copies off a block card. */
const HEIGHT = /^#?(\d{1,9})$/;

/**
 * §6 — a pasted identifier, resolved to the page that shows it, or `null`.
 *
 * "Pasting a full `0x…` transaction hash into the search box resolves to its
 * post." Three kinds of identifier resolve, and each is decided by its own
 * shape, so nothing here can guess: a transaction hash, an address, a block
 * height. Anything else — a word, a slug, a partial hash — is `null`, which is
 * the box's cue to search rather than to navigate.
 *
 * **A pure function of the index.** It reads no ledger and touches no
 * filesystem, so the same rule runs at build time in a test and in the reader's
 * browser over the fetched document; the index's contract is therefore
 * executable rather than a description Task 2 has to reimplement.
 *
 * Case-folded, because a hash copied out of a terminal, a diff or another
 * explorer arrives upper-cased as often as not, and the chain writes hex in
 * lower case throughout. Trimmed, because a paste brings whitespace with it.
 *
 * What deliberately does not resolve: a **block hash**. It is 64 hex like a
 * transaction hash, so it would have to be told apart by lookup rather than by
 * shape, and carrying every block's hash to make that lookup possible costs
 * more bytes than the case is worth — a reader who has a block hash is reading
 * a block page, which already links itself. It returns `null`, and the box
 * falls back to searching, rather than claiming the hash is a post's. What the
 * box does instead of shrugging is `searchFor`'s business, below.
 */
export function resolveIdentifier(index: SearchIndex, query: string): string | null {
  const q = query.trim();
  if (q === '') return null;

  if (TX_HASH.test(q)) {
    const hash = q.toLowerCase();
    const post = index.posts.find(
      (p) => p.hash.toLowerCase() === hash || (p.superseded ?? []).some((h) => h.toLowerCase() === hash),
    );
    return post === undefined ? null : `/tx/${post.slug}`;
  }

  if (ADDRESS.test(q)) {
    const address = q.toLowerCase();
    return index.addresses.find((a) => a.address.toLowerCase() === address)?.href ?? null;
  }

  const height = HEIGHT.exec(q);
  if (height !== null) {
    const n = Number(height[1]);
    return index.blocks.includes(n) ? `/block/${n}` : null;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * The shapes a reader pastes that are not identifiers
 * ------------------------------------------------------------------ */

/**
 * `shortHash`'s own spelling — `0xabc123…def456` — which is what every list
 * view on this site prints and therefore what a reader copies off the screen.
 *
 * Both the real ellipsis and three periods: a reader who pulled the string
 * through a terminal, an editor with an ASCII filter, or a plain-text email
 * arrives with `...`, and telling them their own paste is unrecognisable would
 * be the site refusing to read its own handwriting.
 */
const TRUNCATED = /^0x([0-9a-f]+)\s*(?:…|\.{3})\s*([0-9a-f]+)$/i;

/** `0x` and some hex, but neither a whole hash nor a whole address. */
const PARTIAL = /^0x[0-9a-f]{1,63}$/i;

/* ------------------------------------------------------------------ *
 * Folding
 * ------------------------------------------------------------------ */

/**
 * A string as this box compares it: lower case, with Vietnamese diacritics
 * removed.
 *
 * The one accommodation the box makes to how the corpus is actually typed. Every
 * title on this site is Vietnamese and a reader hunting for a post they have
 * already read types what their keyboard gives them — `ham bam` for
 * `Hàm băm` — so an exact comparison would make most of the corpus
 * unreachable from most keyboards.
 *
 * NFD splits a precomposed letter into its base and a combining mark, which the
 * range below strips. `đ`/`Đ` (U+0111/U+0110) is the exception the range cannot
 * reach: it is a letter in its own right with no decomposition at all, so it
 * gets its own rule, after `toLowerCase` so one rule covers both cases.
 *
 * Not `localeCompare` and not `Intl`: nothing here may depend on the machine's
 * collation (§14), and this runs in a reader's browser, whose locale is
 * whatever it is.
 */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

/**
 * What a result is.
 *
 * `identifier` is the answer to a paste — a hash, an address, a height — and
 * always sorts first, because a reader who pasted one asked a question with a
 * single answer. The other two are matches on text.
 */
export type HitKind = 'identifier' | 'post' | 'address';

export interface SearchHit {
  kind: HitKind;
  /** A page this build produced. Always from the index, never from a tag string. */
  href: string;
  /** The line the reader reads — a post's title or an address's name. */
  label: string;
  /** English chrome under it: what kind of thing this is, and when. */
  detail: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /**
   * Vietnamese prose when there is something a reader needs told: that nothing
   * matched and what this box does not cover, that the hash they pasted is one
   * the site itself shortened, that a 64-hex string may be a block's rather
   * than a transaction's. `null` when the results speak for themselves.
   */
  note: string | null;
}

/* ------------------------------------------------------------------ *
 * What the box says when it cannot answer
 * ------------------------------------------------------------------ */

/**
 * §8/§3 — what is deliberately not in the index, said out loud.
 *
 * A reader who searches a phrase they remember from the middle of a post and
 * gets "no results" will conclude the post is gone, not that prose is not
 * indexed. The three exclusions are stated because each of them is a thing a
 * reader would reasonably expect to find.
 */
export const NOTHING_FOUND =
  'Không có kết quả. Ô này tìm trong tiêu đề, tag, series và mã định danh — không tìm trong ' +
  'lời văn của bài, và bản nháp hay contract thì không nằm trên chuỗi nên không có ở đây.';

/**
 * The site's own display format, handed back to it. `resolveIdentifier`
 * answers `null` for this shape and is right to — an identifier contract has no
 * business guessing from twelve hex digits — but answering a reader "no
 * results" for a string this site printed would be the box calling the site a
 * liar.
 */
export const TRUNCATED_HASH =
  'Đây là hash đã bị rút gọn để hiển thị (0xabc123…def456), và phần bị cắt không đủ để xác định ' +
  'một giao dịch. Dán hash đầy đủ — trang của mỗi giao dịch in đủ 64 chữ số.';

/**
 * §6 — a block hash is 64 hex too, and deliberately does not resolve (see
 * `resolveIdentifier`). Saying only "no results" would leave a reader looking at
 * a hash the site itself printed and concluding it is not on the chain.
 */
export const HASH_NOT_A_TX =
  'Không giao dịch nào trên chuỗi mang hash này. Hash của một khối cũng dài 64 chữ số nhưng không ' +
  'tra được ở đây — khối được liệt kê ở /blocks.';

export const NOT_AN_ADDRESS = 'Không địa chỉ nào trên chuỗi mang hash này.';

/** §6 — the open block's height is a prediction, so it has no page yet. */
export function heightNotSealed(height: number): string {
  return (
    `Chuỗi chưa niêm phong khối #${String(height)}. Khối đang mở chỉ có trang riêng sau khi được ` +
    'đào, vì trước đó chiều cao của nó vẫn còn có thể đổi.'
  );
}

export const PARTIAL_HASH =
  'Chưa đủ một hash: hash giao dịch là 0x cộng 64 chữ số hex, địa chỉ là 0x cộng 40.';

export const INDEX_UNREACHABLE =
  'Không tải được chỉ mục tìm kiếm. Bấm lại vào ô này để thử lần nữa.';

/* ------------------------------------------------------------------ *
 * Building a hit
 * ------------------------------------------------------------------ */

const postDetail = (post: SearchPost): string => {
  const facets = [post.series, ...post.tags].filter((f): f is string => f !== null && f !== '');
  return ['Post', post.date, ...facets].join(' · ');
};

const addressHit = (address: SearchAddress, kind: HitKind): SearchHit => ({
  kind,
  href: address.href,
  label: address.name,
  detail: 'Address',
});

/**
 * The href an identifier resolved to, as a result a reader can read.
 *
 * Built by looking the href back up in the index rather than by carrying the
 * entity through the resolution: `resolveIdentifier` is the one rule that
 * decides what an identifier means, and re-deriving the label from what it
 * returned keeps a second, quietly different resolution from growing here. An
 * href the index cannot account for produces no hit at all.
 */
function identifierHit(index: SearchIndex, href: string): SearchHit | null {
  const slug = /^\/tx\/(.+)$/.exec(href)?.[1];
  if (slug !== undefined) {
    const post = index.posts.find((p) => p.slug === slug);
    return post === undefined
      ? null
      : { kind: 'identifier', href, label: post.title, detail: `Transaction · ${post.date}` };
  }

  const height = /^\/block\/(\d+)$/.exec(href)?.[1];
  if (height !== undefined) {
    return { kind: 'identifier', href, label: `Block #${height}`, detail: 'Sealed block' };
  }

  const address = index.addresses.find((a) => a.href === href);
  return address === undefined ? null : addressHit(address, 'identifier');
}

/**
 * Every transaction hash the index carries, with the post it names.
 *
 * Both halves of §3.9's answer: the governing record's hash and every
 * superseded one, because a block's transaction table shows the original's
 * hash forever and that is the one most likely to be copied off the screen.
 */
function everyHash(index: SearchIndex): { hash: string; post: SearchPost }[] {
  return index.posts.flatMap((post) =>
    [post.hash, ...(post.superseded ?? [])].map((hash) => ({ hash: hash.toLowerCase(), post })),
  );
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/**
 * How many text results the panel offers.
 *
 * Small on purpose. The corpus is fourteen posts and a reader scanning a
 * dropdown reads the first few or gives up; a list long enough to scroll is a
 * list that has stopped answering the question. A query matching more than this
 * is a query to refine, not a list to page through.
 */
const LIMIT = 8;

/** Lower is better. `null` means the entry does not match at all. */
function scorePost(post: SearchPost, q: string): number | null {
  const title = fold(post.title);
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  const facets = [post.series ?? '', ...post.tags].map(fold).filter((f) => f !== '');
  if (facets.some((f) => f === q)) return 2;
  if (facets.some((f) => f.includes(q))) return 3;
  if (fold(post.slug).includes(q) || post.date.includes(q)) return 4;
  return null;
}

function scoreAddress(address: SearchAddress, q: string): number | null {
  const name = fold(address.name);
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return null;
}

/**
 * §6/§8 — the whole box, as a function.
 *
 * Order: the identifier a paste resolved to, then text matches by how squarely
 * they match, and within one score in the index's own order — which is newest
 * first for posts and busiest first for addresses. Nothing here consults a
 * clock or a locale, so the same query gives the same answer on every machine.
 *
 * An address ties ahead of a post at equal score deliberately: a reader who
 * types `cp` on an explorer is more often after everything filed under `cp`
 * than after one post that happens to carry it.
 */
export function searchFor(index: SearchIndex, query: string, limit = LIMIT): SearchOutcome {
  const raw = query.trim();
  if (raw === '') return { hits: [], note: null };

  const hits: SearchHit[] = [];
  let note: string | null = null;

  const direct = resolveIdentifier(index, raw);
  if (direct !== null) {
    const hit = identifierHit(index, direct);
    if (hit !== null) hits.push(hit);
  } else if (TX_HASH.test(raw)) {
    note = HASH_NOT_A_TX;
  } else if (ADDRESS.test(raw)) {
    note = NOT_AN_ADDRESS;
  } else if (HEIGHT.test(raw)) {
    note = heightNotSealed(Number(HEIGHT.exec(raw)![1]));
  } else {
    const truncated = TRUNCATED.exec(raw);
    if (truncated !== null) {
      const head = `0x${truncated[1]!.toLowerCase()}`;
      const tail = truncated[2]!.toLowerCase();
      const matches = everyHash(index).filter(
        ({ hash }) => hash.startsWith(head) && hash.endsWith(tail),
      );
      // Exactly one, or nothing. Two records sharing both ends is vanishingly
      // unlikely and is still not a question this box may answer by guessing.
      const only = matches.length === 1 ? matches[0] : undefined;
      if (only !== undefined) {
        hits.push({
          kind: 'identifier',
          href: `/tx/${only.post.slug}`,
          label: only.post.title,
          detail: `Transaction · ${only.post.date}`,
        });
      } else {
        note = TRUNCATED_HASH;
      }
    } else if (PARTIAL.test(raw)) {
      note = PARTIAL_HASH;
    }
  }

  const q = fold(raw);
  const scored: { hit: SearchHit; score: number; kind: number; order: number }[] = [];
  index.addresses.forEach((address, order) => {
    const score = scoreAddress(address, q);
    if (score !== null) scored.push({ hit: addressHit(address, 'address'), score, kind: 0, order });
  });
  index.posts.forEach((post, order) => {
    const score = scorePost(post, q);
    if (score === null) return;
    scored.push({
      hit: { kind: 'post', href: `/tx/${post.slug}`, label: post.title, detail: postDetail(post) },
      score,
      kind: 1,
      order,
    });
  });

  const taken = new Set(hits.map((h) => h.href));
  let added = 0;
  for (const entry of scored.sort((a, b) => a.score - b.score || a.kind - b.kind || a.order - b.order)) {
    if (added >= limit) break;
    if (taken.has(entry.hit.href)) continue;
    taken.add(entry.hit.href);
    hits.push(entry.hit);
    added += 1;
  }

  if (hits.length === 0 && note === null) note = NOTHING_FOUND;
  return { hits, note };
}
