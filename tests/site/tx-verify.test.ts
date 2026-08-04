import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, cssPerPage, distPages, readDist, rendered, resolvesIn, scriptClosure } from './dist';
import { parseRules, selectorParts } from './css';
import { canonicalAmendmentTx, canonicalPostTx, normalizeBody } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';
import { merkleRootHex } from '../../src/chain/merkle';
import { mine } from '../../src/chain/mine';
import { parsePost } from '../../src/chain/post';
import type { Block, Chain, Transaction } from '../../src/chain/types';
import { verifyTransaction } from '../../src/chain/verify';
import { TX_CHECKS } from '../../src/site/tx-checks';
import { getPendingPosts, getPosts, resolvedPost } from '../../src/site/chain-data';

/**
 * §7 — "Verify this transaction": one post, from the raw text it was written
 * in through to the hash of the block that sealed it.
 *
 * Two halves, and both have to hold or the control is decoration:
 *
 *  - the **canonical source** is actually published, at a path a reader can
 *    `curl`, in the bytes that were hashed. Not the rendered HTML: the
 *    committed `contentHash` is over the normalized Markdown, and neither
 *    normalization nor Markdown rendering is reversible, so hashing the page
 *    proves nothing at all;
 *  - the verification itself **can fail**. Every assertion below that says a
 *    good input passes is paired with one that says a tampered input does not,
 *    because a verifier that cannot fail manufactures confidence.
 */

const BODY_FILE = (slug: string): string => `tx/${slug}/body.txt`;
const PAGE_FILE = (slug: string): string => `tx/${slug}/index.html`;

/** Every post the site builds a page for — sealed history plus the open block. */
function allSlugs(): string[] {
  return [...getPosts(), ...getPendingPosts()].map((t) => t.slug!);
}

const sealedSlug = (): string => getPosts()[0]!.slug!;

/** The canonical source as `dist/` serves it, read as raw bytes. */
function servedBody(slug: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DIST, BODY_FILE(slug))));
}

/** Visible text, tags stripped — so a class name cannot satisfy a prose assertion. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The verify control's own markup on a post page, and nothing around it. */
function controlOf(html: string): string {
  const m = /<section class="card vfy txv"[\s\S]*?<\/section>/.exec(html);
  if (m === null) throw new Error('the post page has no transaction-verify control');
  return m[0];
}

// ---------------------------------------------------------------------------
// Fixtures: chains that are genuinely mined, so tampering with one is a real
// defect rather than a fixture that drifted.
// ---------------------------------------------------------------------------

const DIFFICULTY = 2;
const ZERO = '0x' + '00'.repeat(32);
const FROM = '0x' + 'aa'.repeat(20);

async function postTx(slug: string, body: string, title = `Bài ${slug}`): Promise<Transaction> {
  const fields = {
    title,
    date: '2026-07-01',
    tags: [],
    series: null,
    research: 1,
    from: FROM,
    contentHash: await sha256Hex(body),
    assets: [],
  };
  return {
    hash: await sha256Hex(canonicalPostTx(fields)),
    type: 'post',
    slug,
    title,
    date: fields.date,
    tags: [],
    series: null,
    from: FROM,
    to: [],
    contentHash: fields.contentHash,
    assets: [],
    gasUsed: 10,
    value: 1,
    research: null,
    amends: null,
  };
}

async function amendmentTx(amends: string, body: string, title: string): Promise<Transaction> {
  const fields = {
    amends,
    date: '2026-07-01',
    title,
    tags: [],
    series: null,
    research: 2,
    from: FROM,
    contentHash: await sha256Hex(body),
    assets: [],
  };
  return {
    hash: await sha256Hex(canonicalAmendmentTx(fields)),
    type: 'amendment',
    slug: null,
    title,
    date: fields.date,
    tags: [],
    series: null,
    from: FROM,
    to: [],
    contentHash: fields.contentHash,
    assets: [],
    gasUsed: 0,
    value: 0,
    research: 2,
    amends,
  };
}

async function makeBlock(height: number, prevHash: string, txs: Transaction[]): Promise<Block> {
  const merkleRoot = await merkleRootHex(txs.map((t) => t.hash));
  const header = {
    height,
    prevHash,
    merkleRoot,
    timestamp: `2026-0${height + 1}-01T00:00:00Z`,
    txCount: txs.length,
    gasUsed: txs.reduce((s, t) => s + t.gasUsed, 0),
    difficulty: DIFFICULTY,
  };
  const { nonce, hash } = mine(header, DIFFICULTY);
  return {
    ...header,
    nonce,
    hash,
    period: `2026-0${height + 1}`,
    value: Number(txs.reduce((s, t) => s + t.value, 0).toFixed(1)),
    transactions: txs,
  };
}

const BODY = 'Một đoạn thân bài đã chuẩn hoá.\n';

/** A two-block chain whose second block seals the post under test. */
async function sealedFixture(): Promise<{ chain: Chain; tx: Transaction }> {
  const other = await postTx('khac', 'Thân bài khác.\n');
  const subject = await postTx('bai-viet', BODY);
  const b0 = await makeBlock(0, ZERO, [other]);
  const b1 = await makeBlock(1, b0.hash, [subject]);
  return {
    chain: { version: 1, difficulty: DIFFICULTY, blocks: [b0, b1], assets: [] },
    tx: subject,
  };
}

/** Deep copy, so one test's tampering cannot reach another's fixture. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------

describe('the canonical source is published', () => {
  it('serves one for every post the site builds a page for', () => {
    const slugs = allSlugs();
    expect(slugs.length, 'the chain holds no posts, so this checked nothing').toBeGreaterThan(0);
    for (const slug of slugs) {
      expect(
        existsSync(join(DIST, BODY_FILE(slug))),
        `${BODY_FILE(slug)} is not in the build, so nothing on /tx/${slug} can be re-hashed`,
      ).toBe(true);
    }
  });

  it('hashes to the contentHash the chain committed, for every post', async () => {
    const slugs = allSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const post = resolvedPost(slug)!;
      expect(
        await sha256Hex(servedBody(slug)),
        `the bytes served at /${BODY_FILE(slug)} are not what ${slug} committed`,
      ).toBe(post.contentHash);
    }
  });

  it('serves the normalized Markdown, not the rendered HTML', () => {
    // The whole reason this route exists. `contentHash` is over the normalized
    // body; rendering is not reversible, so a reader handed the HTML could
    // never reach the committed value however carefully they hashed it.
    const slug = sealedSlug();
    const source = readFileSync(join('content/posts', `${slug}.md`), 'utf8');
    const body = normalizeBody(parsePost(join('content/posts', `${slug}.md`), source).body);
    expect(new TextDecoder().decode(servedBody(slug))).toBe(body);
  });

  it('is linked from the post page and resolves in the build', () => {
    for (const slug of allSlugs()) {
      expect(readDist(PAGE_FILE(slug)), `/tx/${slug} does not link its canonical source`).toContain(
        `href="/${BODY_FILE(slug)}"`,
      );
      expect(resolvesIn(DIST, `/${BODY_FILE(slug)}`), `/${BODY_FILE(slug)} is a dead link`).toBe(true);
    }
  });

  it('prints the digest a reader gets from sha256sum, without the 0x the chain writes', () => {
    // `sha256sum` prints 64 bare hex characters followed by two spaces and the
    // input's name. A page that showed the chain's `0x…` spelling instead would
    // leave the reader comparing two strings that differ, in the one place this
    // project cannot afford a false alarm.
    //
    // The whole line, not the digest as a substring: `0x<hex>` *contains*
    // `<hex>`, so a `toContain(bare)` here would go on passing against exactly
    // the mistake it exists to catch. Measured, not assumed.
    const slug = sealedSlug();
    const bare = resolvedPost(slug)!.contentHash.slice(2);
    expect(controlOf(readDist(PAGE_FILE(slug)))).toContain(`\n${bare}  -`);
  });
});

describe('verifyTransaction, on a chain that is genuinely mined', () => {
  it('passes every link for a sealed post', async () => {
    const { chain, tx } = await sealedFixture();
    const result = await verifyTransaction('bai-viet', BODY, tx.hash, chain, null);
    expect(result.reason).toBeUndefined();
    expect(result).toMatchObject({
      recordOk: true,
      bodyOk: true,
      txOk: true,
      merkleOk: true,
      blockOk: true,
      ok: true,
      height: 1,
    });
  });

  it('reports a tampered body as a mismatch, not silently accepted', async () => {
    const { chain, tx } = await sealedFixture();
    const result = await verifyTransaction('bai-viet', `${BODY}một câu thêm vào\n`, tx.hash, chain, null);
    expect(result.bodyOk, 'a forged body was accepted').toBe(false);
    expect(result.ok).toBe(false);
    // The other links are untouched by the forgery, and must still say so —
    // a verifier that reddens everything cannot tell a reader what broke.
    expect(result.txOk).toBe(true);
    expect(result.merkleOk).toBe(true);
    expect(result.blockOk).toBe(true);
  });

  it('catches a forged title with every recorded hash left alone', async () => {
    const { chain, tx } = await sealedFixture();
    const forged = clone(chain);
    forged.blocks[1]!.transactions[0]!.title = 'Một tiêu đề khác hẳn';
    const result = await verifyTransaction('bai-viet', BODY, tx.hash, forged, null);
    expect(result.txOk, 'the recorded fields no longer produce the recorded hash').toBe(false);
    expect(result.ok).toBe(false);
    // The body still hashes to what the (unchanged) contentHash committed —
    // which is exactly why recomputing the transaction hash is not optional.
    expect(result.bodyOk).toBe(true);
  });

  it('catches a Merkle root that does not cover this transaction', async () => {
    const { chain, tx } = await sealedFixture();
    const forged = clone(chain);
    forged.blocks[1]!.merkleRoot = '0x' + 'ab'.repeat(32);
    const result = await verifyTransaction('bai-viet', BODY, tx.hash, forged, null);
    expect(result.merkleOk).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('catches a block header that was never mined to its own hash', async () => {
    const { chain, tx } = await sealedFixture();
    const forged = clone(chain);
    forged.blocks[1]!.nonce += 1;
    const result = await verifyTransaction('bai-viet', BODY, tx.hash, forged, null);
    expect(result.blockOk).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('catches a page that names a transaction other than the chain\'s newest record', async () => {
    const { chain } = await sealedFixture();
    const other = chain.blocks[0]!.transactions[0]!;
    const result = await verifyTransaction('bai-viet', BODY, other.hash, chain, null);
    expect(result.recordOk, 'the page pointed at another transaction and was believed').toBe(false);
    expect(result.ok).toBe(false);
  });

  it('follows the newest amendment, not the sealed original', async () => {
    // §3.9 — after an amendment the body on the page is the amendment's, and
    // so is the hash the page prints. A control that verified the original
    // would report a mismatch on a post that is perfectly in order.
    const original = await postTx('bai-viet', 'Bản đầu.\n');
    const amended = 'Bản đã sửa.\n';
    const first = await amendmentTx(original.hash, 'Bản giữa.\n', 'Tiêu đề giữa');
    const newest = await amendmentTx(original.hash, amended, 'Tiêu đề mới');
    const b0 = await makeBlock(0, ZERO, [original]);
    const b1 = await makeBlock(1, b0.hash, [first]);
    const b2 = await makeBlock(2, b1.hash, [newest]);
    const chain: Chain = { version: 1, difficulty: DIFFICULTY, blocks: [b0, b1, b2], assets: [] };

    const result = await verifyTransaction('bai-viet', amended, newest.hash, chain, null);
    expect(result.hash).toBe(newest.hash);
    expect(result.height).toBe(2);
    expect(result.ok).toBe(true);

    // …and the superseded body is no longer what the chain vouches for.
    const stale = await verifyTransaction('bai-viet', 'Bản đầu.\n', newest.hash, chain, null);
    expect(stale.bodyOk).toBe(false);
  });

  it('prefers a pending amendment over every sealed one', async () => {
    const original = await postTx('bai-viet', 'Bản đầu.\n');
    const sealedAmendment = await amendmentTx(original.hash, 'Bản giữa.\n', 'Giữa');
    const pendingAmendment = await amendmentTx(original.hash, 'Bản mới nhất.\n', 'Mới');
    const b0 = await makeBlock(0, ZERO, [original]);
    const b1 = await makeBlock(1, b0.hash, [sealedAmendment]);
    const chain: Chain = { version: 1, difficulty: DIFFICULTY, blocks: [b0, b1], assets: [] };

    const result = await verifyTransaction(
      'bai-viet',
      'Bản mới nhất.\n',
      pendingAmendment.hash,
      chain,
      [pendingAmendment],
    );
    expect(result.hash).toBe(pendingAmendment.hash);
    expect(result.sealed).toBe(false);
    expect(result.merkleOk).toBeNull();
  });
});

describe('a record with no mined block behind it', () => {
  it('reports the two block-level links as unchecked, never as passed', async () => {
    // §3.6 — a pending transaction has a real hash and no block: no nonce, no
    // proof of work, no Merkle root. `null` is the only honest verdict, and it
    // must not be `true`, which would claim a check that never ran.
    const pending = await postTx('dang-cho', BODY);
    const chain: Chain = { version: 1, difficulty: DIFFICULTY, blocks: [], assets: [] };
    const result = await verifyTransaction('dang-cho', BODY, pending.hash, chain, [pending]);
    expect(result.bodyOk).toBe(true);
    expect(result.txOk).toBe(true);
    expect(result.merkleOk, 'a pending post was told its Merkle root checked out').toBeNull();
    expect(result.blockOk, 'a pending post was told its block hash checked out').toBeNull();
    expect(result.sealed).toBe(false);
    expect(result.height).toBeNull();
    expect(result.ok).toBe(true);
  });

  it('still fails a pending record whose body was tampered with', async () => {
    const pending = await postTx('dang-cho', BODY);
    const chain: Chain = { version: 1, difficulty: DIFFICULTY, blocks: [], assets: [] };
    const result = await verifyTransaction('dang-cho', 'khác\n', pending.hash, chain, [pending]);
    expect(result.bodyOk).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe('verifyTransaction is total over untrusted input', () => {
  it('describes a document that is not a chain instead of throwing', async () => {
    const result = await verifyTransaction('x', '', ZERO, null as unknown as Chain, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('says so when the chain holds no record for the slug', async () => {
    const { chain, tx } = await sealedFixture();
    const result = await verifyTransaction('khong-co', BODY, tx.hash, chain, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/khong-co/);
  });

  it('walks past a structurally broken block to find the record', async () => {
    const { chain, tx } = await sealedFixture();
    const broken = clone(chain) as unknown as { blocks: unknown[] };
    broken.blocks[0] = null;
    const result = await verifyTransaction('bai-viet', BODY, tx.hash, broken as unknown as Chain, null);
    expect(result.bodyOk).toBe(true);
    expect(result.txOk).toBe(true);
  });
});

describe('the control on a post page', () => {
  it('offers "Verify this transaction" on every post page', () => {
    const slugs = allSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      expect(controlOf(readDist(PAGE_FILE(slug)))).toContain('Verify this transaction');
    }
  });

  it('names every step, and what each one proves, without JavaScript', () => {
    const control = controlOf(readDist(PAGE_FILE(sealedSlug())));
    const body = text(control);
    expect(body.length, 'the control is an empty shell without JavaScript').toBeGreaterThan(400);
    for (const check of TX_CHECKS) {
      expect(body, `the static control never names ${check.label}`).toContain(check.label);
      expect(body, `the static control never explains ${check.label}`).toContain(text(rendered(check.note)));
    }
    expect(body, 'the control does not say it needs JavaScript to run').toMatch(/JavaScript/);
  });

  it('gives the two commands a reader can check it with by hand', () => {
    // The property the whole design is chosen for: a reader who does not trust
    // this JavaScript can reach the same verdict with curl and sha256sum.
    const control = controlOf(readDist(PAGE_FILE(sealedSlug())));
    expect(control).toMatch(/curl/);
    expect(control).toMatch(/sha256sum/);
    expect(control).toContain(`/${BODY_FILE(sealedSlug())}`);
  });

  it('says on a pending post that the block-level links do not exist yet', (ctx) => {
    const pending = getPendingPosts();
    // An **explicit skip**, never a silent return. `npm run demo:clear` leaves a
    // chain with nothing unsealed, and a test that quietly passed there would
    // report green on a state in which it checked nothing at all — which is
    // exactly the shape of half the dead tests this project has shipped.
    if (pending.length === 0) ctx.skip('this chain has no open block to check');
    const control = text(controlOf(readDist(PAGE_FILE(pending[0]!.slug!))));
    expect(control).toMatch(/chưa (được )?đào|chưa niêm phong/i);
    for (const check of TX_CHECKS.filter((c) => c.sealedOnly)) {
      expect(control, `${check.label} is offered on a pending post as though it could run`).toContain(
        check.label,
      );
    }
    expect(control).toMatch(/không kiểm được|chưa kiểm được/i);
  });

  it('makes no such claim on a sealed post', () => {
    // Anti-vacuity for the assertion above: if that notice were printed on
    // every post page it would prove nothing about the pending case.
    const control = text(controlOf(readDist(PAGE_FILE(sealedSlug()))));
    expect(control).not.toMatch(/không kiểm được|chưa kiểm được/i);
  });
});

describe('what actually reaches the browser', () => {
  const page = (): string => PAGE_FILE(sealedSlug());

  it('ships a module script, and every file it imports resolves', () => {
    const { files, code } = scriptClosure(page());
    expect(files.length, 'the post page ships no JavaScript at all').toBeGreaterThan(0);
    for (const file of files) {
      expect(existsSync(join(DIST, file.replace(/^\//, ''))), `${file} is not in the build`).toBe(true);
    }
    expect(code.length).toBeGreaterThan(1000);
  });

  it('ships the very same verifier the build runs, not a copy of it', () => {
    // Strings only `src/chain/verify.ts` produces.
    const { code } = scriptClosure(page());
    expect(code).toContain('is not a 0x-prefixed');
  });

  it('hashes with the browser\'s own WebCrypto', () => {
    const { code } = scriptClosure(page());
    expect(code).toContain('SHA-256');
    expect(code).toMatch(/subtle\.digest/);
    expect(code, 'a node: specifier reached the browser bundle').not.toContain('node:');
    expect(code, 'a Node global was polyfilled into the bundle').not.toMatch(/\bBuffer\b|\bprocess\.env\b/);
  });

  it('fetches nothing but same-origin paths (§9)', () => {
    const { code } = scriptClosure(page());
    expect(code, 'the control does not fetch the ledger at all').toMatch(/fetch\(\s*["'`]\/chain\.json/);
    expect(code, 'the control does not fetch the canonical source at all').toMatch(/body\.txt/);
    let seen = 0;
    for (const m of code.matchAll(/fetch\(\s*(["'`])([^"'`]*)\1/g)) {
      seen += 1;
      expect(m[2]!.startsWith('/'), `the control fetches ${m[2]!}, which is not same-origin`).toBe(true);
    }
    expect(seen, 'no fetch target was found to check').toBeGreaterThan(0);
    expect(code, 'the bundle names an absolute url').not.toMatch(/https?:\/\//);
  });

  it('carries a stamp for a partial run that is not the one for a complete one', () => {
    // §3.6 — a green "Verified" beside two dashes is read as "checked". The
    // stamp is the part a reader takes in without reading anything else, so a
    // run that could only check three of five links must not wear the same one.
    const { code } = scriptClosure(page());
    expect(code).toContain('Verified');
    expect(code, 'a partial check wears the same stamp as a complete one').toContain('Partial');
  });

  it('carries each step label and the field it reports', () => {
    const { code } = scriptClosure(page());
    for (const check of TX_CHECKS) {
      expect(code, `the bundle never labels ${check.label}`).toContain(check.label);
      expect(code, `the bundle never reads ${check.field}`).toContain(check.field);
    }
  });

  it('names exactly the verdict fields TxVerification carries', () => {
    const source = readFileSync('src/chain/verify.ts', 'utf8');
    const shape = /export interface TxVerification \{([\s\S]*?)\n\}/.exec(source);
    expect(shape, 'TxVerification is no longer declared as an interface').not.toBeNull();
    const declared = [...shape![1]!.matchAll(/^\s{2}(\w+Ok)\??:/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(TX_CHECKS.map((c) => c.field).sort()).toEqual(declared.sort());
  });
});

describe('the control under eleven palettes', () => {
  const RULES = ['.txv-step', '.txv-run', '.txv-cmd', '.txv-note'];

  it('uses no hard-coded colour in the verify stylesheet', () => {
    const rules = parseRules(readFileSync('src/styles/verify.css', 'utf8'));
    expect(rules.length, 'verify.css parsed to no rules at all').toBeGreaterThan(0);
    const selectors = new Set(rules.flatMap(selectorParts));
    for (const rule of RULES) {
      expect(
        [...selectors].some((s) => s.split(/\s+/).includes(rule) || s.includes(rule)),
        `${rule} is not a rule in verify.css — the guard is not scanning it`,
      ).toBe(true);
    }
    for (const rule of rules) {
      expect(rule.body, `${rule.selector} hard-codes a colour instead of using a token`).not.toMatch(
        /#[0-9a-f]{3,8}\b|rgba?\(/i,
      );
    }
  });

  it('ships those rules to every post page', () => {
    const css = cssPerPage();
    for (const slug of allSlugs()) {
      const sheet = css.get(PAGE_FILE(slug));
      expect(sheet, `${PAGE_FILE(slug)} loads no CSS at all`).toBeDefined();
      for (const rule of RULES) {
        expect(
          parseRules(sheet!).some((r) => selectorParts(r).some((p) => p.split(/\s+/).includes(rule))),
          `built css for ${PAGE_FILE(slug)} has no rule for ${rule}`,
        ).toBe(true);
      }
    }
  });
});

describe('the control is derived, not dated', () => {
  it('reads no clock (§14)', () => {
    for (const file of [
      'src/site/tx-checks.ts',
      'src/components/TxVerifier.astro',
      'src/pages/tx/[slug]/body.txt.ts',
    ]) {
      expect(readFileSync(file, 'utf8'), `${file} reads the clock`).not.toMatch(
        /new Date\(\)|Date\.now\(\)/,
      );
    }
  });

  it('publishes the canonical source at a path every page in the build can reach', () => {
    // Anti-vacuity for the link check above: the route must exist as a real
    // file in `dist`, not only as an href nothing resolves.
    expect(distPages().length).toBeGreaterThan(1);
    expect(existsSync(join(DIST, BODY_FILE(sealedSlug())))).toBe(true);
  });
});
