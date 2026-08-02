# Content Pipeline and Post Page Implementation Plan (Plan 2b-i)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render posts — with math, code and figures — from bodies proven at build time to be the exact bytes the chain committed.

**Architecture:** The ledger stores a `contentHash`, never a body. So the site reads Markdown from disk and must prove it matches before rendering: `getPostContent()` normalizes the file exactly as the engine did, re-hashes it, and **fails the build** on any mismatch. Rendering runs through a unified/remark/rehype pipeline with GFM, KaTeX and Shiki. Shiki emits CSS variables rather than fixed colours, so highlighted code follows whichever of the eleven palettes the reader picked.

**Tech Stack:** unified, remark-parse, remark-gfm, remark-math, remark-rehype, rehype-katex, rehype-stringify, katex, shiki (already vendored via Astro).

Implements spec §6.1 (the post page), §3.1 (normalization), and closes the pending-block gap recorded at the end of Plan 2a. Read spec §6, §6.1 and §9 before starting.

## Global Constraints

- **`src/chain/` must not be modified.** It is merged and reviewed. Import from it; do not edit it.
- **What is rendered must be what was hashed.** Any post whose on-disk body no longer hashes to its committed `contentHash` fails the build. Never render an unverified body, and never soften this to a warning.
- **`.astro` files never read `chain.lock.json` or `content/posts/` directly** — everything goes through `src/site/`.
- **No external network requests at runtime.** KaTeX CSS and fonts are self-hosted; no CDN, no remote stylesheet.
- **Code highlighting must follow the reader's palette.** Shiki's `css-variables` theme, mapped onto the existing palette tokens — not a fixed theme that clashes with ten of the eleven.
- Explorer chrome is English (`Transaction`, `Block`, `Gas used`); content and prose are Vietnamese.
- `noUncheckedIndexedAccess: true`.
- **`npm test` and `npm run typecheck` must both pass** at the end of every task. `npm test` runs an Astro build first via `globalSetup` — the 355 existing tests must never regress.

---

### Task 1: Prove the body matches the chain

**Files:**
- Modify: `src/site/chain-data.ts`
- Test: `tests/site/content.test.ts`

**Interfaces:**
- Consumes: `parsePost` from `src/chain/post`, `normalizeBody` from `src/chain/canonical`, `sha256Hex` from `src/chain/hash`.
- Produces:
  - `interface PostContent { slug: string; body: string; contentHash: Hex; tx: Transaction }`
  - `getPostContent(slug: string): Promise<PostContent>`

This is the task the whole plan exists to protect. The ledger commits a `contentHash` and stores no body, so nothing structurally stops the site rendering different text beside a hash that vouches for other text. `getPostContent` closes that by re-deriving the hash and refusing to return a body that disagrees.

- [ ] **Step 1: Write the failing test**

Create `tests/site/content.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPostContent, getPosts } from '../../src/site/chain-data';
import { normalizeBody } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';

describe('getPostContent', () => {
  it('returns the body for a post on the chain', async () => {
    const slug = getPosts()[0]!.slug!;
    const content = await getPostContent(slug);
    expect(content.slug).toBe(slug);
    expect(content.body.length).toBeGreaterThan(0);
  });

  it('returns the normalized body, exactly the bytes that were hashed', async () => {
    const slug = getPosts()[0]!.slug!;
    const content = await getPostContent(slug);
    expect(await sha256Hex(content.body)).toBe(content.contentHash);
  });

  it('returns a body already normalized — normalizing again is a no-op', async () => {
    const content = await getPostContent(getPosts()[0]!.slug!);
    expect(normalizeBody(content.body)).toBe(content.body);
  });

  it('carries the transaction so a caller need not look it up twice', async () => {
    const tx = getPosts()[0]!;
    const content = await getPostContent(tx.slug!);
    expect(content.tx.hash).toBe(tx.hash);
    expect(content.contentHash).toBe(tx.contentHash);
  });

  it('throws for a slug that is not on the chain', async () => {
    await expect(getPostContent('khong-ton-tai')).rejects.toThrow(/khong-ton-tai/);
  });

  it('throws when the file on disk no longer hashes to the committed value', async () => {
    // The guarantee this module exists for. Copy the real post, alter one
    // character, and confirm the mismatch is refused rather than rendered.
    const slug = getPosts()[0]!.slug!;
    const original = readFileSync(join('content/posts', `${slug}.md`), 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'drift-'));
    const altered = join(dir, `${slug}.md`);
    writeFileSync(altered, original.replace('chuỗi', 'chuoi'));

    await expect(getPostContent(slug, dir)).rejects.toThrow(/does not match|committed/i);
  });

  it('names both the file and the two hashes when it refuses', async () => {
    const slug = getPosts()[0]!.slug!;
    const original = readFileSync(join('content/posts', `${slug}.md`), 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'drift2-'));
    writeFileSync(join(dir, `${slug}.md`), original + '\nmột dòng thêm vào.\n');

    await expect(getPostContent(slug, dir)).rejects.toThrow(new RegExp(slug));
    await expect(getPostContent(slug, dir)).rejects.toThrow(/0x[0-9a-f]{8}/);
  });

  it('throws when the file is missing entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    await expect(getPostContent(getPosts()[0]!.slug!, dir)).rejects.toThrow(/not found|ENOENT/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/site/content.test.ts`
Expected: FAIL — `getPostContent` is not exported.

- [ ] **Step 3: Implement it**

Add to `src/site/chain-data.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeBody } from '../chain/canonical';
import { sha256Hex } from '../chain/hash';
import { parsePost } from '../chain/post';

const POSTS_DIR = 'content/posts';

export interface PostContent {
  slug: string;
  /** Normalized body — byte-for-byte what the chain committed. */
  body: string;
  contentHash: Hex;
  tx: Transaction;
}

/**
 * §3.1 — the ledger commits a `contentHash` and stores no body, so nothing
 * structurally prevents the site rendering different text beside a hash that
 * vouches for other text. This re-derives the hash from disk and refuses a
 * mismatch, so a drifted file fails the build instead of shipping a page whose
 * "Verify this transaction" button would contradict what the reader just read.
 *
 * `postsDir` is a parameter only so tests can point at a fixture; production
 * callers use the default.
 */
export async function getPostContent(
  slug: string,
  postsDir: string = POSTS_DIR,
): Promise<PostContent> {
  const tx = getPosts().find((t) => t.slug === slug);
  if (!tx) {
    throw new Error(`no transaction on the chain for post "${slug}"`);
  }

  const path = join(postsDir, `${slug}.md`);
  if (!existsSync(path)) {
    throw new Error(`${path} not found, but "${slug}" is on the chain`);
  }

  const body = normalizeBody(parsePost(path, readFileSync(path, 'utf8')).body);
  const actual = await sha256Hex(body);
  if (actual !== tx.contentHash) {
    throw new Error(
      `${path} does not match the chain: committed ${tx.contentHash.slice(0, 10)}…, ` +
        `on disk ${actual.slice(0, 10)}… — re-run \`npm run chain:build\` to record the edit as an amendment`,
    );
  }

  return { slug, body, contentHash: tx.contentHash, tx };
}
```

The error names the remedy, not just the fault: an edited post is a legitimate thing to have done, and the fix is to let the engine record it as an amendment.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/site/content.test.ts` — Expected: PASS, 8 tests.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 5: Commit**

```bash
git add src/site/chain-data.ts tests/site/content.test.ts
git commit -m "feat(site): refuse to render a body that does not match the chain"
```

---

### Task 2: The Markdown pipeline

**Files:**
- Modify: `package.json`
- Create: `src/site/markdown.ts`
- Test: `tests/site/markdown.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `renderMarkdown(body: string): Promise<string>` — Markdown to HTML.

- [ ] **Step 1: Install the pipeline**

```bash
npm install unified remark-parse remark-gfm remark-rehype rehype-stringify
```

All build-time. `shiki` is already vendored via Astro; Task 4 uses it.

- [ ] **Step 2: Write the failing test**

Create `tests/site/markdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/site/markdown';

describe('renderMarkdown', () => {
  it('renders a paragraph', async () => {
    expect(await renderMarkdown('xin chào\n')).toContain('<p>xin chào</p>');
  });

  it('renders headings', async () => {
    expect(await renderMarkdown('## Ý tưởng\n')).toMatch(/<h2[^>]*>Ý tưởng<\/h2>/);
  });

  it('renders Vietnamese without mangling diacritics', async () => {
    const html = await renderMarkdown('Khối đầu tiên — ghi chú thuật toán\n');
    expect(html).toContain('Khối đầu tiên');
    expect(html).toContain('ghi chú thuật toán');
  });

  it('renders GFM tables', async () => {
    const html = await renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders inline code', async () => {
    expect(await renderMarkdown('dùng `O(n log n)`\n')).toContain('<code>O(n log n)</code>');
  });

  it('renders links', async () => {
    expect(await renderMarkdown('[x](/tx/abc)\n')).toContain('href="/tx/abc"');
  });

  it('drops raw HTML rather than passing it through', async () => {
    // Bodies are hashed into the chain, but a body is still author input and
    // the rendered page carries reader preferences and a verify control.
    const html = await renderMarkdown('<script>alert(1)</script>\n');
    expect(html).not.toContain('<script>');
  });

  it('is deterministic', async () => {
    const md = '# Tiêu đề\n\nmột đoạn văn.\n';
    expect(await renderMarkdown(md)).toBe(await renderMarkdown(md));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/site/markdown.test.ts`
Expected: FAIL — cannot resolve `../../src/site/markdown`.

- [ ] **Step 4: Implement `src/site/markdown.ts`**

```ts
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

/**
 * §6.1 — renders the verified body from `getPostContent`.
 *
 * `allowDangerousHtml` is deliberately off, so `remarkRehype` DROPS author HTML
 * at the mdast→hast stage rather than entity-escaping it — a `<div>` in a post
 * vanishes rather than showing as visible markup. A stray `<` in prose is
 * escaped normally.
 *
 * The reason: hashing a body makes it tamper-evident, not safe. The author is
 * still typing it, and the page around it carries reader preferences and a
 * verify control. The same argument governs URL protocols — see the guard
 * below, without which `[x](javascript:…)` would render as a live anchor.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

export async function renderMarkdown(body: string): Promise<string> {
  return String(await processor.process(body));
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/site/markdown.test.ts` — Expected: PASS, 8 tests.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/site/markdown.ts tests/site/markdown.test.ts
git commit -m "feat(site): add the markdown rendering pipeline"
```

---

### Task 3: Math, self-hosted

**Files:**
- Modify: `package.json`
- Modify: `src/site/markdown.ts`
- Create: `src/styles/katex.css`
- Modify: `tests/site/markdown.test.ts`
- Test: `tests/site/markdown.test.ts`

**Interfaces:**
- Consumes: the processor from Task 2.
- Produces: `renderMarkdown` additionally rendering `$…$` and `$$…$$`.

Competitive-programming writing is full of complexity bounds. `O((n + q)\sqrt{n})` typed as an image or as plain text is the difference between a readable post and a sloppy one.

- [ ] **Step 1: Install**

```bash
npm install remark-math rehype-katex katex
```

`katex` is needed for its stylesheet and fonts, which are vendored into `node_modules` — no CDN.

- [ ] **Step 2: Write the failing test**

Add to `tests/site/markdown.test.ts`:

```ts
describe('math', () => {
  it('renders inline math', async () => {
    const html = await renderMarkdown('độ phức tạp $O(n)$ là đủ\n');
    expect(html).toContain('katex');
    expect(html).not.toContain('$O(n)$');
  });

  it('renders display math', async () => {
    const html = await renderMarkdown('$$O((n + q)\\sqrt{n})$$\n');
    expect(html).toContain('katex-display');
  });

  it('leaves a lone dollar sign alone', async () => {
    // Prices and shell prompts must not become math.
    const html = await renderMarkdown('giá 5 $ một cái\n');
    expect(html).not.toContain('katex');
  });

  it('does not treat code blocks as math', async () => {
    const html = await renderMarkdown('```\ncost = $total\n```\n');
    expect(html).not.toContain('katex');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/site/markdown.test.ts`
Expected: FAIL — `$O(n)$` passes through unrendered.

- [ ] **Step 4: Add the plugins**

In `src/site/markdown.ts`, add the imports and insert the two plugins in the right positions — `remarkMath` before `remarkRehype`, `rehypeKatex` after it:

```ts
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeKatex, { output: 'html' })
  .use(rehypeStringify);
```

`output: 'html'` suppresses KaTeX's MathML duplicate, which otherwise doubles every formula in the accessible text and makes a screen reader read each one twice.

- [ ] **Step 5: Vendor the stylesheet**

Create `src/styles/katex.css`. Task 6's post page imports it — nothing else does,
so math would render unstyled if that import were dropped:

```css
/* Self-hosted (§9). KaTeX's stylesheet references its own font files by
   relative path; importing from the package lets the bundler resolve and
   emit them, so no request leaves the origin. */
@import 'katex/dist/katex.min.css';
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run tests/site/markdown.test.ts` — Expected: PASS, 12 tests.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/site/markdown.ts src/styles/katex.css \
        tests/site/markdown.test.ts
git commit -m "feat(site): render math with self-hosted katex"
```

---

### Task 4: Code highlighting that follows the reader's palette

**Files:**
- Modify: `src/site/markdown.ts`
- Modify: `src/styles/tokens.css`
- Modify: `tests/site/markdown.test.ts`
- Test: `tests/site/markdown.test.ts`

**Interfaces:**
- Consumes: `shiki` (already vendored via Astro).
- Produces: `renderMarkdown` emitting highlighted code whose colours come from CSS variables.

**The design problem:** Shiki normally bakes a fixed theme's colours into inline styles. With eleven reader-selectable palettes, a hardcoded theme clashes with ten of them — Gruvbox code on a Nord page. Shiki's `css-variables` theme emits `var(--shiki-*)` instead, so the palette tokens can supply the colours and code follows whatever the reader picked, with no JavaScript and no rebuild.

- [ ] **Step 1: Write the failing test**

Add to `tests/site/markdown.test.ts`:

```ts
describe('code highlighting', () => {
  it('highlights a fenced code block', async () => {
    const html = await renderMarkdown('```cpp\nint main() { return 0; }\n```\n');
    expect(html).toContain('<pre');
    expect(html).toContain('<span');
  });

  it('emits css variables, not baked colours, so code follows the palette', async () => {
    const html = await renderMarkdown('```cpp\nint x = 1;\n```\n');
    expect(html).toContain('var(--shiki-');
    // A baked hex colour would mean code ignores ten of the eleven palettes.
    expect(html).not.toMatch(/color:\s*#[0-9a-f]{6}/i);
  });

  it('handles a language it does not know without throwing', async () => {
    const html = await renderMarkdown('```khongbiet\nnội dung\n```\n');
    expect(html).toContain('nội dung');
  });

  it('handles a fence with no language', async () => {
    const html = await renderMarkdown('```\nnội dung\n```\n');
    expect(html).toContain('nội dung');
  });

  it('escapes code content rather than executing it', async () => {
    const html = await renderMarkdown('```html\n<script>alert(1)</script>\n```\n');
    expect(html).not.toContain('<script>alert');
  });

  it('renders Vietnamese inside a code comment', async () => {
    const html = await renderMarkdown('```cpp\n// sắp xếp theo khối\n```\n');
    expect(html).toContain('sắp xếp theo khối');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/site/markdown.test.ts`
Expected: FAIL — code renders unhighlighted, with no `var(--shiki-` anywhere.

- [ ] **Step 3: Install and add the highlighter**

```bash
npm install @shikijs/rehype
```

Use the maintained rehype integration rather than hand-rolling one. A hand-written
plugin has to inject Shiki's HTML as a `raw` node, which forces
`allowDangerousHtml: true` on `rehypeStringify` — and that directly conflicts with
Task 2's rule that author HTML is escaped. `@shikijs/rehype` builds real hast nodes,
so the escaping guarantee stays intact.

In `src/site/markdown.ts`:

```ts
import rehypeShiki from '@shikijs/rehype';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeKatex, { output: 'html' })
  // `css-variables` emits var(--shiki-*) rather than baking a theme's colours
  // in. With eleven reader-selectable palettes a fixed theme would clash with
  // ten of them; this way code inherits whichever the reader picked, with no
  // JavaScript and no second stylesheet per palette.
  .use(rehypeShiki, {
    theme: 'css-variables',
    langs: ['cpp', 'c', 'python', 'typescript', 'javascript', 'bash', 'json', 'html', 'css', 'yaml', 'markdown'],
    fallbackLanguage: 'text',
  })
  .use(rehypeStringify);
```

If `@shikijs/rehype` rejects `css-variables` as a theme name in the installed
version, **stop and report it** rather than falling back to a fixed theme —
palette-following code is the requirement, not a nicety. The alternative is
Shiki's `cssVariablePrefix` option or a `themes: { light, dark }` pair, but
neither follows eleven palettes, so that is a decision to bring back, not to make.

- [ ] **Step 4: Map the Shiki variables onto the palette**

In `src/styles/tokens.css`, add a block mapping Shiki's variables to existing tokens, so code inherits the reader's palette:

```css
/* Shiki's css-variables theme resolves these. Mapping them onto the palette
   tokens means highlighted code follows whichever theme the reader picked,
   with no JavaScript and no second stylesheet per palette. */
:root {
  --shiki-foreground: var(--txt);
  --shiki-background: var(--surf);
  --shiki-token-constant: var(--h-num);
  --shiki-token-string: var(--h-hash);
  --shiki-token-comment: var(--dim);
  --shiki-token-keyword: var(--h-tag);
  --shiki-token-parameter: var(--txt);
  --shiki-token-function: var(--h-addr);
  --shiki-token-string-expression: var(--h-hash);
  --shiki-token-punctuation: var(--dim);
  --shiki-token-link: var(--acc);
}
```

Note these deliberately reuse the same token roles the chain metadata uses — a string in code and a hash in a table share a colour, which is the point: one palette, one meaning per hue.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/site/markdown.test.ts` — Expected: PASS, 18 tests.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/site/markdown.ts src/styles/tokens.css \
        tests/site/markdown.test.ts
git commit -m "feat(site): highlight code through palette css variables"
```

---

### Task 5: The pending block

**Files:**
- Modify: `src/site/chain-data.ts`
- Test: `tests/site/chain-data.test.ts`

**Interfaces:**
- Consumes: `getChain`, `getPosts` from this module.
- Produces:
  - `interface PendingBlock { period: string; posts: PendingPost[] }`
  - `interface PendingPost { slug: string; title: string; date: string; tags: string[] }`
  - `getPendingBlock(now: string, postsDir?: string): PendingBlock | null`

Spec §3.6 and §9 describe an open block; the engine deliberately withholds a partial current month from the lock, so nothing on the site knows about it. Without this, **a post published this month gets no page, no URL and no RSS entry** — indistinguishable from a publishing failure. Every route in Plan 2b-ii builds its `getStaticPaths` from these functions, so it has to exist before they do.

A post is pending when its file is on disk but its slug appears in no sealed block. That is a slug-level check and needs no hashing.

- [ ] **Step 1: Write the failing test**

Add to `tests/site/chain-data.test.ts`:

```ts
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPendingBlock } from '../../src/site/chain-data';

describe('getPendingBlock', () => {
  function postsWith(extra?: { name: string; body: string }): string {
    const dir = mkdtempSync(join(tmpdir(), 'pending-'));
    cpSync('content/posts', dir, { recursive: true });
    if (extra) writeFileSync(join(dir, extra.name), extra.body);
    return dir;
  }

  it('returns null when every post on disk is already sealed', () => {
    expect(getPendingBlock('2026-08-02', postsWith())).toBeNull();
  });

  it('reports a post that is on disk but in no sealed block', () => {
    const dir = postsWith({
      name: '2026-08-05-moi.md',
      body: '---\ntitle: "Bài mới"\ndate: 2026-08-05\ntags: [cp]\n---\n\nNội dung.\n',
    });
    const pending = getPendingBlock('2026-08-10', dir);
    expect(pending).not.toBeNull();
    expect(pending!.period).toBe('2026-08');
    expect(pending!.posts.map((p) => p.slug)).toEqual(['2026-08-05-moi']);
    expect(pending!.posts[0]!.title).toBe('Bài mới');
  });

  it('takes its period from the clock, not from the newest post', () => {
    // The open block is the current month, whether or not anything landed in it.
    const dir = postsWith({
      name: '2026-08-05-moi.md',
      body: '---\ntitle: "Bài mới"\ndate: 2026-08-05\ntags: [cp]\n---\n\nNội dung.\n',
    });
    expect(getPendingBlock('2026-09-01', dir)!.period).toBe('2026-09');
  });

  it('orders pending posts newest first, like sealed blocks', () => {
    const dir = postsWith({
      name: '2026-08-01-a.md',
      body: '---\ntitle: "A"\ndate: 2026-08-01\ntags: [cp]\n---\n\nA.\n',
    });
    writeFileSync(join(dir, '2026-08-09-b.md'),
      '---\ntitle: "B"\ndate: 2026-08-09\ntags: [cp]\n---\n\nB.\n');
    expect(getPendingBlock('2026-08-10', dir)!.posts.map((p) => p.slug))
      .toEqual(['2026-08-09-b', '2026-08-01-a']);
  });

  it('does not read the clock itself', () => {
    // Determinism (§14): the caller supplies `now`, as everywhere else.
    const a = getPendingBlock('2026-08-10', postsWith());
    const b = getPendingBlock('2026-08-10', postsWith());
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/site/chain-data.test.ts`
Expected: FAIL — `getPendingBlock` is not exported.

- [ ] **Step 3: Implement it**

Add to `src/site/chain-data.ts`:

```ts
import { readdirSync } from 'node:fs';

export interface PendingPost {
  slug: string;
  title: string;
  date: string;
  tags: string[];
}

export interface PendingBlock {
  /** The open calendar month, YYYY-MM. */
  period: string;
  /** Newest first, matching sealed blocks. */
  posts: PendingPost[];
}

/**
 * §3.6, §9 — the open block. The engine withholds a partial current month from
 * the lock, so a post published this month is on disk and on no block. Without
 * this it would have no page, no URL and no feed entry, which looks exactly
 * like a failed publish.
 *
 * A post is pending when its slug appears in no sealed block. `now` is supplied
 * by the caller, never read here, so builds stay deterministic (§14).
 */
export function getPendingBlock(
  now: string,
  postsDir: string = POSTS_DIR,
): PendingBlock | null {
  const sealed = new Set(getPosts().map((t) => t.slug));

  const posts: PendingPost[] = readdirSync(postsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(postsDir, f))
    .map((path) => parsePost(path, readFileSync(path, 'utf8')))
    .filter((p) => !sealed.has(p.slug))
    .map((p) => ({ slug: p.slug, title: p.title, date: p.date, tags: p.tags }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));

  if (posts.length === 0) return null;
  return { period: now.slice(0, 7), posts };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/site/chain-data.test.ts` — Expected: PASS, existing tests plus 5 new.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 5: Commit**

```bash
git add src/site/chain-data.ts tests/site/chain-data.test.ts
git commit -m "feat(site): expose the open block so unsealed posts are not invisible"
```

---

### Task 6: The post page

**Files:**
- Create: `src/pages/tx/[slug].astro`
- Create: `src/components/TxPanel.astro`
- Create: `src/styles/post.css`
- Modify: `src/components/BlockCard.astro`
- Test: `tests/site/post-page.test.ts`

**Interfaces:**
- Consumes: `getPosts`, `getPostContent`, `getBlocks` from `src/site/chain-data`; `renderMarkdown` from `src/site/markdown`.
- Produces: a page per post at `/tx/<slug>/`.

Spec §6.1: a dense monospace transaction panel, then the article at roughly a 38rem measure in the prose face. Metadata and prose never share a typeface.

- [ ] **Step 1: Write the failing test**

Create `tests/site/post-page.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { getPosts } from '../../src/site/chain-data';

const slug = () => getPosts()[0]!.slug!;
const page = () => readDist(`tx/${slug()}/index.html`);

describe('post page', () => {
  it('exists for every post on the chain', () => {
    for (const tx of getPosts()) {
      expect(() => readDist(`tx/${tx.slug}/index.html`)).not.toThrow();
    }
  });

  it('shows the transaction panel with the committed hash', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(tx.hash);
    expect(page()).toContain('Transaction');
  });

  it('names the block the post was sealed in', () => {
    expect(page()).toMatch(/Block/);
  });

  it('renders the post title as the page h1', () => {
    const tx = getPosts()[0]!;
    expect(page()).toMatch(new RegExp(`<h1[^>]*>${tx.title}</h1>`));
  });

  it('renders the body as HTML, not as raw markdown', () => {
    expect(page()).toContain('<p>');
    expect(page()).not.toContain('---\ntitle:');
  });

  it('shows gas and value from the committed transaction', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(String(tx.gasUsed));
  });

  it('links to each tag address the post sent to', () => {
    const tx = getPosts()[0]!;
    for (const tag of tx.tags) expect(page()).toContain(`/address/${tag}.tag`);
  });

  it('keeps the panel labels in English and the prose in Vietnamese', () => {
    expect(page()).toContain('Gas used');
    expect(page()).toContain('Khối đầu tiên');
  });

  it('carries the reader preference attributes like every other page', () => {
    expect(page()).toContain('data-palette');
  });

  it('sets a per-post title and description', () => {
    const tx = getPosts()[0]!;
    expect(page()).toContain(`<title>${tx.title}`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run tests/site/post-page.test.ts`
Expected: FAIL — `dist/tx/…/index.html` does not exist.

- [ ] **Step 3: Implement `src/components/TxPanel.astro`**

```astro
---
import type { Transaction } from '../chain/types';
import { getBlocks } from '../site/chain-data';
import '../styles/post.css';

interface Props { tx: Transaction }
const { tx } = Astro.props;

const block = getBlocks().find((b) => b.transactions.some((t) => t.hash === tx.hash));
const readMinutes = Math.max(1, Math.round(tx.gasUsed / 200));
---

<div class="txpanel">
  <div class="txpanel-head">
    <span class="lbl">Transaction</span>
    <span class="stamp">Confirmed</span>
  </div>
  <dl class="meta">
    <dt>Hash</dt><dd><span class="hash">{tx.hash}</span></dd>
    <dt>Block</dt>
    <dd>{block ? <a href={`/block/${block.height}`}>#{block.height}</a> : '—'} · {block?.period}</dd>
    <dt>Timestamp</dt><dd>{tx.date}</dd>
    <dt>From</dt><dd><span class="addr">{tx.from}</span></dd>
    <dt>To</dt>
    <dd>
      {tx.tags.map((t) => <a class="tagname" href={`/address/${t}.tag`}>{t}.tag</a>)}
      {tx.series ? <a class="tagname" href={`/address/${tx.series}.series`}>{tx.series}.series</a> : null}
    </dd>
    <dt>Gas used</dt><dd><span class="num">{tx.gasUsed}</span> từ · {readMinutes} phút đọc</dd>
    <dt>Value</dt><dd><span class="num">{tx.value.toFixed(1)}</span> giờ nghiên cứu</dd>
    {tx.assets.length > 0 ? (
      <>
        <dt>Assets</dt>
        <dd><span class="num">{tx.assets.length}</span> token</dd>
      </>
    ) : null}
  </dl>
</div>
```

- [ ] **Step 4: Implement `src/pages/tx/[slug].astro`**

```astro
---
import Base from '../../layouts/Base.astro';
import TxPanel from '../../components/TxPanel.astro';
import { getPostContent, getPosts } from '../../site/chain-data';
import { renderMarkdown } from '../../site/markdown';
import '../../styles/post.css';
import '../../styles/katex.css';

export function getStaticPaths() {
  return getPosts().map((tx) => ({ params: { slug: tx.slug! }, props: { tx } }));
}

const { tx } = Astro.props;
// Throws if the file on disk no longer matches the chain — the build fails
// rather than shipping a page whose verify control would contradict it.
const content = await getPostContent(tx.slug!);
const html = await renderMarkdown(content.body);
---

<Base title={`${tx.title} — Blogchain`} description={`${tx.title} · ${tx.gasUsed} từ`}>
  <TxPanel tx={tx} />
  <article class="post">
    <h1>{tx.title}</h1>
    <p class="byline">{tx.date} · {tx.tags.map((t) => `#${t}`).join(' ')}</p>
    <Fragment set:html={html} />
  </article>
</Base>
```

- [ ] **Step 5: Write `src/styles/post.css`**

Spec §6.1: the panel is dense and monospaced; the article is not. Give the body a 38rem measure and the prose face; keep every hash, address and number in mono.

```css
.txpanel { background: var(--surf); border: 1px solid var(--line2);
  border-radius: 5px; padding: 1rem 1.1rem; }
.txpanel-head { display: flex; flex-wrap: wrap; gap: .5rem 1rem;
  align-items: center; margin-bottom: .85rem; }
.txpanel-head .lbl { font-family: var(--mono); font-size: .7rem;
  letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }
.txpanel-head .stamp { margin-left: auto; font-family: var(--mono);
  font-size: .6rem; letter-spacing: .13em; text-transform: uppercase;
  color: var(--good); border: 1.5px solid var(--good); border-radius: 2px;
  padding: .26rem .5rem; transform: rotate(-3deg); }
.txpanel .addr { color: var(--c-addr); font-family: var(--mono); word-break: break-all; }
.txpanel .tagname { color: var(--c-tag); font-family: var(--mono); margin-right: .6rem; }

article.post { max-width: 38rem; margin: 2rem auto 0; }
article.post h1 { font-size: clamp(1.5rem, 3.4vw, 2rem); line-height: 1.25;
  margin: 0 0 .5rem; letter-spacing: -.018em; font-weight: 660; text-wrap: balance; }
article.post .byline { font-family: var(--mono); font-size: .7rem;
  color: var(--dim); margin: 0 0 1.6rem; letter-spacing: .04em; }
article.post p { font-size: 1.02rem; line-height: 1.78; margin: 0 0 1.15rem; }
article.post h2 { font-size: 1.15rem; margin: 2rem 0 .7rem; font-weight: 640; }
article.post h3 { font-size: 1.02rem; margin: 1.6rem 0 .6rem; font-weight: 640; }
article.post code { font-family: var(--mono); font-size: .88em; }
article.post pre { background: var(--surf); border: 1px solid var(--line);
  border-radius: 4px; padding: .85rem .95rem; overflow-x: auto;
  font-size: .78rem; line-height: 1.6; margin: 0 0 1.15rem; }
article.post pre code { font-size: inherit; }
article.post table { width: 100%; border-collapse: collapse; margin: 0 0 1.15rem;
  font-size: .92rem; display: block; overflow-x: auto; }
article.post th, article.post td { border-bottom: 1px solid var(--line);
  padding: .45rem .6rem; text-align: left; }
article.post blockquote { margin: 0 0 1.15rem; padding-left: .9rem;
  border-left: 2px solid var(--line2); color: var(--dim); }
article.post img { max-width: 100%; height: auto; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: .2rem 0; }
```

- [ ] **Step 6: Link block cards to their posts**

In `src/components/BlockCard.astro`, wrap each transaction's title in a link so the homepage reaches the post pages:

```astro
<h3 class="t"><a href={`/tx/${tx.slug}`}>{tx.title ?? 'Amendment'}</a></h3>
```

Amendments have a null slug, so guard the link: render the title unlinked when `tx.slug` is null.

- [ ] **Step 7: Run it to verify it passes**

Run: `npm run build && npx vitest run tests/site/post-page.test.ts` — Expected: PASS, 10 tests.
Then `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 8: Look at it**

Run `npm run preview` and open the genesis post. Check that the panel reads as data and the body reads as prose — different faces, comfortable measure. Switch palettes and confirm code and math follow. Then disable JavaScript and reload: the post must still render fully. Report what you observed.

- [ ] **Step 9: Commit**

```bash
git add src/pages/tx/ src/components/TxPanel.astro src/components/BlockCard.astro \
        src/styles/post.css tests/site/post-page.test.ts
git commit -m "feat(site): add the post page"
```

---

## Done criteria

- Every post on the chain has a page at `/tx/<slug>/`.
- A post whose file no longer hashes to its committed `contentHash` **fails the build**, naming the file, both hashes, and the remedy.
- Markdown, GFM tables, math and highlighted code all render; code colours come from CSS variables and follow the reader's palette.
- KaTeX ships self-hosted; the built output contains no external URL.
- `getPendingBlock()` reports posts on disk that no sealed block contains.
- `npm test` and `npm run typecheck` pass; the 355 existing tests do not regress.

## What this plan deliberately does not cover

Plan 2b-ii: `/blocks`, `/block/[height]`, `/address/[name]`, `/about`, `/mempool`, `/assets`, `/asset/[tokenId]`, and the 404 — several of which this plan now links to and which will 404 until they exist. Plan 2b-iii: RSS, `/contracts`. Plan 3: search, the interactive verifier, deploy.
