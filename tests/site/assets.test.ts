import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRules, selectorParts } from './css';
import { DIST, distPages, readDist, resolvesIn } from './dist';
import { buildSandbox, chainBuildSandbox, sandboxRepo } from './sandbox';
import { sha256Hex } from '../../src/chain/hash';
import type { AssetRecord, Hex, Transaction } from '../../src/chain/types';
import {
  assetEmbed,
  assetMime,
  assetViews,
  getAssetView,
  getAssetViews,
  supersedingToken,
} from '../../src/site/assets-view';
import { routeById } from '../../src/site/routes';

/**
 * §3.2b — `/assets` and `/asset/<tokenId>`: the files posts reference, minted
 * as tokens so that verifying a post covers its diagrams and not only its text.
 *
 * **The live chain has zero assets**, and that is the state this ships in — so
 * every populated assertion here is driven either through a fabricated registry
 * handed straight to `assetViews`, or through a *sandbox copy* of the repository
 * with a real image, a real `chain:build` and a real `astro build`. An assertion
 * over the live registry would pass vacuously forever whatever the code did.
 *
 * The one defect this file exists to keep out: after an image swap two tokens
 * share a `file`, and a page that trusts the registry's `file` field shows the
 * NEW image beside the OLD hash and calls it verified. The end-to-end swap case
 * below is the check that survives a rewrite of the view module.
 */

// Two different files under one name — the swap this route has to survive.
// Deliberately different lengths, so a size taken from the wrong one is visible.
const V1 = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n';
const V2 = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>\n';
const FILE = 'so-do.svg';

const bytesOf = (s: string): number => Buffer.byteLength(s);

function assetsDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'assets-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** A registry record. `bytes` and `mime` are deliberately settable to a lie. */
function record(over: Partial<AssetRecord> & { hash: Hex }): AssetRecord {
  return {
    tokenId: 1,
    file: FILE,
    mime: 'image/svg+xml',
    bytes: 0,
    mintedIn: 0,
    ...over,
  };
}

function transaction(over: Partial<Transaction> & { hash: Hex }): Transaction {
  return {
    type: 'post',
    slug: 'bai-viet',
    title: 'Bài viết',
    date: '2026-08-02',
    tags: ['meta'],
    series: null,
    from: '0x' + '11'.repeat(20),
    to: [],
    contentHash: '0x' + '22'.repeat(32),
    assets: [],
    gasUsed: 10,
    value: 0,
    research: null,
    amends: null,
    ...over,
  };
}

describe('assetViews', () => {
  it('marks a token superseded when the file on disk no longer hashes to it', async () => {
    // Two tokens can share a `file` after an image swap. Trusting the registry's
    // `file` field would show the NEW image on the OLD token's page and call it
    // verified — the file shown would not be the file the hash commits to.
    const dir = assetsDirWith({ [FILE]: V2 });
    const old = record({ tokenId: 1, hash: await sha256Hex(V1), bytes: bytesOf(V1), mintedIn: 2 });
    const fresh = record({ tokenId: 2, hash: await sha256Hex(V2), bytes: bytesOf(V2), mintedIn: 3 });

    const views = await assetViews([old, fresh], [], dir);
    expect(views.map((v) => v.tokenId), 'newest token first').toEqual([2, 1]);

    const superseded = views.find((v) => v.tokenId === 1)!;
    const current = views.find((v) => v.tokenId === 2)!;
    expect(superseded.current, 'the old token claims the file that now holds another image').toBe(false);
    expect(current.current, 'the token the file actually is was not recognised').toBe(true);

    // And the old token must not borrow the new file's size — that number
    // describes the image on disk, which is not the image it commits to.
    expect(superseded.bytesOnDisk).toBeNull();
    expect(current.bytesOnDisk).toBe(bytesOf(V2));
    expect(bytesOf(V1)).not.toBe(bytesOf(V2));

    expect(supersedingToken(superseded, views), 'the page cannot name what replaced it').toBe(2);
    expect(supersedingToken(current, views)).toBeNull();
  });

  it('lists every transaction that references the token, and no other', async () => {
    const dir = assetsDirWith({ [FILE]: V1 });
    const hash = await sha256Hex(V1);
    const other = await sha256Hex(V2);
    const txs = [
      transaction({ hash: '0xaa', slug: 'mot', assets: [hash] }),
      transaction({ hash: '0xbb', slug: 'hai', assets: [other] }),
      transaction({ hash: '0xcc', slug: 'ba', assets: [other, hash] }),
      transaction({ hash: '0xdd', slug: 'bon', assets: [] }),
    ];

    const [view] = await assetViews([record({ hash })], txs, dir);
    expect(view!.referencedBy.map((t) => t.slug)).toEqual(['mot', 'ba']);
  });

  it('re-derives the byte size from disk and never prints the recorded number', async () => {
    // §14 — `bytes` is committed to no hash anywhere on the chain (see
    // `registryProblem` in src/chain/verify.ts), so a hand-edited ledger can
    // claim any size it likes. The same rule `gasUsed` is under.
    const dir = assetsDirWith({ [FILE]: V1 });
    const [view] = await assetViews([record({ hash: await sha256Hex(V1), bytes: 999_999 })], [], dir);
    expect(view!.bytesOnDisk).toBe(bytesOf(V1));
    expect(view!.bytes, 'the record itself is reported as recorded').toBe(999_999);
    expect(view!.bytesOnDisk).not.toBe(view!.bytes);
  });

  it('reports no size at all for a token whose file is gone', async () => {
    const dir = assetsDirWith({});
    const [view] = await assetViews([record({ hash: await sha256Hex(V1), bytes: 4321 })], [], dir);
    expect(view!.current).toBe(false);
    expect(view!.bytesOnDisk, 'a missing file was reported at its recorded size').toBeNull();
  });

  it('refuses to read outside the assets directory', async () => {
    // `file` is not covered by any hash. `assetRecordProblem` rejects a path
    // like this on read, so this is defence in depth — but the view module is
    // the one that turns the field into a filesystem read.
    const dir = assetsDirWith({ [FILE]: V1 });
    for (const file of ['../secret.svg', '.', '..', 'sub/x.svg']) {
      const [view] = await assetViews([record({ hash: await sha256Hex(V1), file })], [], dir);
      expect(view!.current, `${file} was followed off the assets directory`).toBe(false);
      expect(view!.bytesOnDisk).toBeNull();
    }
  });

  it('embeds an image from the bytes it just hashed, and nothing else', async () => {
    // The embed is a `data:` URI built from bytes checked against the token's
    // own hash in the same call, so what a reader sees is by construction the
    // file the hash commits to. A non-image type gets no embed at all — and a
    // token whose file is gone gets none either, because the chain stores
    // hashes and not bytes.
    const dir = assetsDirWith({ [FILE]: V1, 'ghi-chu.txt': 'không phải ảnh\n' });

    const [image] = await assetViews([record({ hash: await sha256Hex(V1) })], [], dir);
    expect(assetMime(image!)).toBe('image/svg+xml');
    expect(await assetEmbed(image!, dir)).toBe(
      `data:image/svg+xml;base64,${Buffer.from(V1).toString('base64')}`,
    );

    const text = record({ hash: await sha256Hex('không phải ảnh\n'), file: 'ghi-chu.txt' });
    const [notAnImage] = await assetViews([text], [], dir);
    expect(notAnImage!.current).toBe(true);
    expect(assetMime(notAnImage!)).toBe('text/plain');
    expect(await assetEmbed(notAnImage!, dir), 'a text file was embedded as an image').toBeNull();

    const [gone] = await assetViews([record({ hash: await sha256Hex(V2) })], [], dir);
    expect(await assetEmbed(gone!, dir), 'a token whose file is gone was given an image').toBeNull();
    expect(assetMime(gone!)).toBeNull();
  });

  it('reads no clock', () => {
    // §14 — nothing under `src/site/` may read the clock.
    expect(readFileSync('src/site/assets-view.ts', 'utf8')).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});

describe('the live registry, which is empty', () => {
  it('has no tokens and no token to look up', async () => {
    // Pins the state the shipped build describes. Not a substitute for the
    // fixtures above: this assertion cannot fail while the chain has no assets,
    // which is exactly why nothing else in this file rests on it.
    expect(await getAssetViews()).toEqual([]);
    expect(await getAssetView(1)).toBeUndefined();
  });
});

describe('the assets route', () => {
  it('is built, so its nav entry is a real link', () => {
    expect(routeById('assets').built).toBe(true);
    expect(distPages()).toContain('assets/index.html');
    expect(resolvesIn(DIST, '/assets')).toBe(true);
  });

  it('ships an assets directory for an author to write into', () => {
    expect(existsSync('content/assets'), 'content/assets is not there').toBe(true);
    expect(existsSync('content/assets/.gitkeep'), 'content/assets is not committed').toBe(true);
  });
});

describe('an empty registry', () => {
  const html = (): string => readDist('assets/index.html');

  it('says there are no tokens rather than rendering a bare page', () => {
    expect(html(), 'the empty gallery rendered a token list').not.toMatch(/<ul class="tokens">/);
    expect(html()).toMatch(/Chưa có token nào/);
  });

  it('still says what an asset is', () => {
    expect(html()).toMatch(/băm/);
  });

  it('links no token page, because there is none', () => {
    expect(html()).not.toMatch(/href="\/asset\//);
    expect(distPages().some((p) => p.startsWith('asset/'))).toBe(false);
  });
});

describe('a registry with a token in it', () => {
  const SLUG = '2026-08-02-so-do';
  const POST = [
    '---',
    'title: "Sơ đồ khối"',
    'date: 2026-08-02',
    'tags: [meta]',
    'research: 2.0',
    '---',
    '',
    'Một bài viết có hình.',
    '',
    `![Sơ đồ](/assets/${FILE})`,
    '',
  ].join('\n');

  /** The gallery and both token pages, before and after the image is swapped. */
  let dir = '';
  let galleryV1 = '';
  let detailV1 = '';
  let galleryV2 = '';
  let oldToken = '';
  let newToken = '';
  let galleryGone = '';
  let goneToken = '';

  beforeAll(() => {
    dir = sandboxRepo();
    mkdirSync(join(dir, 'content/assets'), { recursive: true });
    writeFileSync(join(dir, 'content/assets', FILE), V1);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), POST);

    // The asset is minted when the block holding the post seals, so the clock
    // has to move past the post's month: 2026-08 opens, then 2026-09 seals it.
    for (const now of ['2026-08-05', '2026-09-05']) {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
    }
    const one = buildSandbox(dir);
    if (one.status !== 0) throw new Error(`sandbox build with one asset failed:\n${one.output}`);
    galleryV1 = readFileSync(join(dir, 'dist/assets/index.html'), 'utf8');
    detailV1 = readFileSync(join(dir, 'dist/asset/1/index.html'), 'utf8');

    // The swap: same filename, different image. The post body is untouched, so
    // only the committed asset hash changes — which changes the transaction
    // hash and produces an amendment.
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    for (const now of ['2026-09-05', '2026-10-05']) {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build after the swap at ${now} failed:\n${built.output}`);
    }
    const two = buildSandbox(dir);
    if (two.status !== 0) throw new Error(`sandbox build after the swap failed:\n${two.output}`);
    galleryV2 = readFileSync(join(dir, 'dist/assets/index.html'), 'utf8');
    oldToken = readFileSync(join(dir, 'dist/asset/1/index.html'), 'utf8');
    newToken = readFileSync(join(dir, 'dist/asset/2/index.html'), 'utf8');

    // And the third state a file can be in: gone. The registry is append-only
    // (the transactions referencing it are sealed and immutable), so both
    // tokens survive with nothing on disk to measure.
    //
    // The post has to stop referencing it first, and that edit has to be
    // recorded. Deleting the file under a post that still embeds it is now a
    // build failure — a post shipping `<img src="/assets/so-do.svg">` with
    // nothing at that path is a broken diagram the author was never told
    // about — and `tests/site/asset-drift.test.ts` is where that failure is
    // pinned. What this fixture needs is the *other* state: the file gone and
    // no current transaction referencing it, which is the only way tokens can
    // legitimately outlive their bytes.
    rmSync(join(dir, 'content/assets', FILE));
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), POST.replace(`![Sơ đồ](/assets/${FILE})\n`, ''));
    const dropped = chainBuildSandbox(dir, '2026-10-05');
    if (dropped.status !== 0) throw new Error(`chain:build after dropping the reference failed:\n${dropped.output}`);
    const none = buildSandbox(dir);
    if (none.status !== 0) throw new Error(`sandbox build with the file deleted failed:\n${none.output}`);
    galleryGone = readFileSync(join(dir, 'dist/assets/index.html'), 'utf8');
    goneToken = readFileSync(join(dir, 'dist/asset/2/index.html'), 'utf8');
    writeFileSync(join(dir, 'content/assets', FILE), V2);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), POST);
  }, 600_000);

  /** The registry the sandbox's own build wrote — never a literal in this file. */
  function registry(): AssetRecord[] {
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      assets: AssetRecord[];
    };
    return lock.assets;
  }

  it('mints exactly one token for the file the post references', () => {
    expect(registry().map((a) => a.tokenId)).toEqual([1, 2]);
    expect(registry()[0]!.file).toBe(FILE);
  });

  it('lists the token with a middle-truncated hash, never the full one', () => {
    const hash = registry()[0]!.hash;
    expect(galleryV1).toContain(`${hash.slice(0, 8)}…${hash.slice(-6)}`);
    expect(galleryV1, 'a list printed a full 64-hex hash').not.toContain(hash);
    expect(galleryV1).toContain('href="/asset/1"');
  });

  it('shows the full hash on the token\'s own page', () => {
    expect(detailV1).toContain(registry()[0]!.hash);
  });

  it('shows the size on disk, the mint block and the minter', () => {
    expect(detailV1, 'the size was not re-derived from the file').toContain(`>${bytesOf(V1)}</span> byte`);
    const mintedIn = registry()[0]!.mintedIn;
    expect(detailV1).toContain(`href="/block/${mintedIn}">#${mintedIn}</a>`);

    // The minter is the `from` of the transaction that first referenced it —
    // a committed field, not a registry one.
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      blocks: { height: number; transactions: { from: string; assets: string[] }[] }[];
    };
    const minter = lock.blocks
      .find((b) => b.height === mintedIn)!
      .transactions.find((t) => t.assets.includes(registry()[0]!.hash))!.from;
    expect(detailV1).toContain(minter);
  });

  it('names the post that references it, and links its transaction', () => {
    expect(detailV1).toContain(`href="/tx/${SLUG}"`);
    expect(detailV1).toContain('Sơ đồ khối');
  });

  it('embeds the image itself', () => {
    expect(detailV1).toContain(`data:image/svg+xml;base64,${Buffer.from(V1).toString('base64')}`);
  });

  it('never sources an image from a path, on any token page', () => {
    // The page-level half of the carried defect. `<img src="/assets/so-do.svg">`
    // is only as trustworthy as the registry's `file` field, which no hash
    // covers and which two tokens share after a swap — so the superseded token
    // would render the image that replaced it and stamp its own hash beside it.
    // A `data:` URI cannot: its bytes were hashed against this token in the
    // same call that produced them.
    let checked = 0;
    for (const page of [detailV1, oldToken, newToken, goneToken]) {
      for (const m of page.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)) {
        const src = m[1]!;
        checked++;
        expect(
          src.startsWith('data:'),
          `an image was sourced from ${src} rather than from bytes checked against the token's hash`,
        ).toBe(true);
      }
    }
    expect(checked, 'no token page rendered an image at all — this checked nothing').toBeGreaterThan(0);
  });

  it('shows no price, rarity, edition or transfer history', () => {
    // §3.2b rules these out by name: they have no referent on a personal blog.
    // The embedded image is stripped first — base64 is not prose, and letting
    // it into the scan would make this test's outcome depend on the fixture's
    // bytes rather than on the page's words.
    const prose = (html: string): string => html.replace(/data:[^"']+/g, '');
    for (const page of [galleryV1, detailV1, galleryV2, oldToken, newToken]) {
      for (const word of ['price', 'rarity', 'edition', 'transfer']) {
        expect(prose(page).toLowerCase()).not.toContain(word);
      }
    }
  });

  describe('after the image is swapped', () => {
    it('mints a second token and keeps the first', () => {
      expect(registry()).toHaveLength(2);
      expect(registry()[0]!.file, 'the two tokens do not share a file — the case is not exercised')
        .toBe(registry()[1]!.file);
    });

    it('lists both tokens, newest first', () => {
      const ids = [...galleryV2.matchAll(/href="\/asset\/(\d+)"/g)].map((m) => m[1]!);
      expect(ids).toEqual(['2', '1']);
    });

    it('does not show the new image on the old token\'s page', () => {
      // The carried defect, end to end. The file on disk is now V2; token #1
      // commits to V1. Rendering `/assets/so-do.svg` — or its bytes — beside
      // token #1's hash would present an image the hash does not cover.
      expect(oldToken, 'the superseded token embedded the image that replaced it')
        .not.toContain(Buffer.from(V2).toString('base64'));
      expect(oldToken, 'the superseded token embedded an image at all').not.toContain('data:image');
      expect(newToken).toContain(`data:image/svg+xml;base64,${Buffer.from(V2).toString('base64')}`);
    });

    it('says the old token is superseded, and names what replaced it', () => {
      expect(oldToken).toMatch(/không còn/);
      expect(oldToken).toContain('href="/asset/2"');
      expect(newToken, 'the current token was marked superseded').not.toMatch(/không còn/);
    });

    it('prints no size for the superseded token', () => {
      // The file at that path is V2's size, and V2 is not what token #1
      // commits to. An em dash, never a number describing another image.
      expect(oldToken, 'the superseded token borrowed the replacement\'s size')
        .not.toContain(`>${bytesOf(V2)}</span> byte`);
      expect(oldToken, 'the superseded token printed the recorded size')
        .not.toContain(`>${bytesOf(V1)}</span> byte`);
      expect(oldToken).toMatch(/<dt>Size<\/dt><dd>—<\/dd>/);
      expect(newToken).toContain(`>${bytesOf(V2)}</span> byte`);
    });

    it('keeps both tokens listed once the file is deleted, with nothing to measure', () => {
      // Every field that needs the bytes goes to an em dash at once, and the
      // page must not claim another token replaced this one — nothing did.
      expect(goneToken).toMatch(/<dt>Size<\/dt><dd>—<\/dd>/);
      expect(goneToken).toMatch(/<dt>Type<\/dt><dd>—<\/dd>/);
      expect(goneToken, 'a deleted file was still embedded').not.toContain('data:image');
      expect(goneToken, 'a token nothing superseded was said to be superseded')
        .not.toMatch(/href="\/asset\/\d+"/);
      // Append-only: the tokens outlive the files (§3.2b).
      expect([...galleryGone.matchAll(/href="\/asset\/(\d+)"/g)].map((m) => m[1]!)).toEqual(['2', '1']);
    });

    it('still shows each token its own hash, in full', () => {
      const [first, second] = registry();
      expect(oldToken).toContain(first!.hash);
      expect(oldToken, 'the old token page printed the new token\'s hash').not.toContain(second!.hash);
      expect(newToken).toContain(second!.hash);
    });
  });
});

describe('the asset styles', () => {
  it('styles the token list and the embed through tokens, never a literal colour', () => {
    const rules = parseRules(readFileSync('src/styles/chain.css', 'utf8'));
    for (const selector of ['.tokens', '.tokens .id', '.token-art img', '.stamp.stale']) {
      const rule = rules.find((r) => selectorParts(r).includes(selector));
      expect(rule, `${selector} is not a rule in chain.css — the guard is not scanning it`).toBeDefined();
      expect(rule!.body, `${selector} hard-codes a colour`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});
