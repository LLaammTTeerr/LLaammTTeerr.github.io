# Pending Transactions and Block Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a post published into the current, unsealed month a first-class citizen of the site — real hash, real page, real URL — and give the chain the block-browsing routes it has been missing.

**Architecture:** `getPendingBlock` stops returning a stub shape and returns real `Transaction` objects built through the engine's own `toTransaction`, so a pending post's hash is the same value its sealed hash will be. Sealed and pending blocks then share one view type discriminated by a `sealed` boolean, letting `BlockCard` render both. Two bugs found by running the amendment flow end-to-end are fixed first, because both make the pending block unreachable in exactly the case it matters most.

**Tech Stack:** Astro 7 static output, TypeScript, Vitest. No new dependencies.

## Global Constraints

- **No module under `src/site/` may read the clock.** `now` is always an injected `YYYY-MM-DD` parameter. A golden-file snapshot test guards determinism.
- **`verify.ts` and its transitive import closure** (`canonical.ts`, `hash.ts`, `merkle.ts`, `types.ts`) must never reach a Node built-in or a bare package specifier — it runs in the browser. An import-graph test guards this.
- **`verifyChain` must never throw** on untrusted input, for any input.
- **Sealed blocks are frozen.** Never recompute a block already in `chain.lock.json`.
- **No hard-coded colours.** Eleven reader-selectable palettes; every colour resolves through a token in `src/styles/tokens.css`. A literal hex is wrong in ten palettes.
- **Explorer chrome is English; all author-facing content is Vietnamese.** Match the Vietnamese already used in existing components.
- **`noUncheckedIndexedAccess: true`.** Indexing an array yields `T | undefined`.
- Author HTML is dropped, not escaped; only `http`/`https`/`mailto` survive on `a[href]` and `img[src]`.
- A hash renders **truncated with a middle ellipsis in lists**, and **in full on a record's own detail page** (spec §3.2, amended 2026-08-02).
- Every displayed field must be a committed one (§14). If a number is derived or defaulted, it must not be presented as chain-attested.

## Scope

**In:** the two amendment bugs, pending transactions with real hashes, the C+A pending treatment on `BlockCard` and `TxPanel`, `/blocks`, `/block/[height]`, `/404`.

**Out, deferred to Plan 2b-iii:** `/address/[name]`, `/about`, `/assets`, `/asset/[tokenId]`, `/mempool`. Deferred to 2b-iv: RSS, `/contracts`. This plan is everything about *blocks*; addresses and assets are a separate subsystem with their own data shapes.

## File Structure

| File | Responsibility |
|---|---|
| `src/chain/build.ts` (modify) | `fromPeriod` must be the first *still-open* month, not the tip's own period |
| `src/site/chain-data.ts` (modify) | `getPostContent` accepts an amended body; `getPendingBlock` returns real transactions; `PendingBlockView` |
| `src/components/PendingState.astro` (create) | The C+A state row, one component, caller supplies the trailing payload |
| `src/components/BlockCard.astro` (modify) | Renders sealed and pending blocks; stamp and meter become conditional |
| `src/components/TxPanel.astro` (modify) | `~` prefix, derived stamp, block link for pending transactions |
| `src/pages/tx/[slug].astro` (modify) | `getStaticPaths` includes pending posts |
| `src/pages/blocks.astro` (create) | Full block list |
| `src/pages/block/[height].astro` (create) | One block's detail page |
| `src/pages/404.astro` (create) | Not-found page |
| `src/styles/chain.css` (modify) | `.a-hash`, `.c-state` and pending card styles |

---

### Task 1: An amendment must not seal into a month that already closed

**Why this is first:** running the documented edit flow end to end shows the amendment landing in a *newly sealed* block whose period is the tip's period (`2026-07`), not the open month (`2026-08`). Two consequences: the chain grows a second block for a month that already ended, and the pending block never receives amendments at all — so the thing the rest of this plan builds stays empty in the one case that matters most. Spec §3.6: "A transaction dated earlier than the first still-open month … is placed in that open month." With a tip at `2026-07` and a clock in `2026-08`, the first still-open month is `2026-08`.

**Files:**
- Modify: `src/chain/build.ts:229`
- Modify: `src/chain/seal.ts` (export `maxPeriod` if not already exported)
- Test: `tests/chain/seal.test.ts`

**Interfaces:**
- Consumes: `planBlocks(pending, opts)`, `monthOf(date)` from `src/chain/period.ts`.
- Produces: no signature change. Behaviour change only.

- [ ] **Step 1: Write the failing test**

In `tests/chain/seal.test.ts`:

```ts
it('places a transaction entering the chain today in the open month, not the tip month', () => {
  // Tip is 2026-07 and already sealed. An amendment carrying an old date
  // enters the chain on 2026-08-02. §3.6: block membership is when a
  // transaction entered the chain, so it belongs to 2026-08 — the first
  // still-open month — and must NOT mint a second 2026-07 block after
  // 2026-07 has closed.
  const drafts = planBlocks(
    [{ ...txFixture(), date: '2026-06-15' }],
    { now: '2026-08-02', maxTxPerBlock: 4, fromPeriod: firstOpenPeriod('2026-07', '2026-08-02') },
  );
  expect(drafts.map((d) => d.period)).not.toContain('2026-07');
  expect(drafts.every((d) => d.period <= '2026-08')).toBe(true);
});

it('still lets a busy current month split into two blocks of the same period', () => {
  // The size rule legitimately produces two blocks in one period. Raising the
  // floor must not break that: this is intra-build splitting, not a closed
  // month being reopened across builds.
  const five = Array.from({ length: 5 }, (_, i) => ({ ...txFixture(), date: `2026-08-0${i + 1}` }));
  const drafts = planBlocks(five, {
    now: '2026-08-20', maxTxPerBlock: 4, fromPeriod: firstOpenPeriod('2026-08', '2026-08-20'),
  });
  expect(drafts.filter((d) => d.period === '2026-08').length).toBe(2);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/chain/seal.test.ts -t 'open month'`
Expected: FAIL — `firstOpenPeriod is not defined`.

- [ ] **Step 3: Add `firstOpenPeriod` to `src/chain/seal.ts`**

```ts
/**
 * The earliest period a transaction entering the chain now may join.
 *
 * Blocks are non-decreasing, so it can never precede the tip. But it must also
 * never precede the current month: once a month has ended AND the tip has
 * sealed a block in it, that month is closed, and appending another block to it
 * later would mean a completed month silently gained a transaction after the
 * fact. Taking the later of the two satisfies both — and leaves a tip already
 * inside the current month alone, so the size rule can still split a busy month
 * into two blocks of the same period.
 */
export function firstOpenPeriod(tipPeriod: string | null, now: string): string | null {
  const current = monthOf(now);
  if (tipPeriod === null) return null;
  return tipPeriod > current ? tipPeriod : current;
}
```

Import `monthOf` from `./period` if `seal.ts` does not already.

- [ ] **Step 4: Use it in `src/chain/build.ts:229`**

Replace:

```ts
    fromPeriod: lastBlock ? lastBlock.period : null,
```

with:

```ts
    fromPeriod: firstOpenPeriod(lastBlock ? lastBlock.period : null, opts.now),
```

and add `firstOpenPeriod` to the existing `./seal` import.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. **If a golden-file snapshot test fails, stop and report it** — it means this changes the output of an existing fixture chain, and whether that is correct needs a human decision, not a snapshot update.

- [ ] **Step 6: Commit**

```bash
git add src/chain/seal.ts src/chain/build.ts tests/chain/seal.test.ts
git commit -m "fix(chain): place new transactions in the open month, not the tip's"
```

---

### Task 2: Editing a sealed post must not brick the build

**Why:** the current behaviour is a dead end. Edit a sealed post → the site build fails with "re-run `npm run chain:build` to record the edit as an amendment" → you run it, it records the amendment → **the site build fails with the identical message, forever.** `getPostContent` compares the file on disk against the *sealed* transaction's `contentHash`, which by design never changes. The advice the error gives does not work, and no post can ever be edited.

The fix: a body matches the chain if it matches the sealed `contentHash` **or** the `contentHash` of the most recent amendment to that post. Both are committed values, so nothing unverified is introduced.

**Files:**
- Modify: `src/site/chain-data.ts` (`getPostContent`)
- Test: `tests/site/chain-data.test.ts`

**Interfaces:**
- Consumes: `getChain()`, `getPosts()`, `Transaction.amends`, `Transaction.contentHash`.
- Produces: `getPostContent(slug, postsDir?)` — unchanged signature, returns `PostContent` whose `contentHash` is now **the currently valid one** (the amendment's if amended, else the sealed one).

- [ ] **Step 1: Write the failing test**

In `tests/site/chain-data.test.ts`:

```ts
it('accepts a body whose hash matches an amendment, not just the sealed post', async () => {
  // Reproduces the dead end: chain:build records an edit as an amendment, but
  // getPostContent still compares against the frozen sealed contentHash, so
  // the build fails with advice that has already been followed.
  const dir = mkdtempSync(join(tmpdir(), 'bc-amend-'));
  const tx = getPosts()[0]!;
  const amended = 'Thân bài đã được sửa sau khi khối niêm phong.\n';
  writeFileSync(
    join(dir, `${tx.slug}.md`),
    `---\ntitle: ${tx.title}\ndate: ${tx.date}\ntags: [${tx.tags.join(', ')}]\n---\n\n${amended}`,
  );
  // An amendment on the chain committing to the edited body.
  const amendment = { amends: tx.hash, contentHash: await sha256Hex(normalizeBody(amended)) };
  await expect(getPostContent(tx.slug!, dir, [amendment])).resolves.toMatchObject({
    contentHash: amendment.contentHash,
  });
});
```

**Note for the implementer:** the third parameter above is a seam for the test. Decide the real shape while implementing — the requirement is that the amendment set comes from the chain, not from the caller in production. If injecting it is the only testable route, default it to a function that reads the chain, and say so in your report.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/site/chain-data.test.ts -t 'amendment'`
Expected: FAIL — the error message names the sealed `contentHash`.

- [ ] **Step 3: Implement**

In `getPostContent`, replace the single-hash comparison with a set of accepted hashes:

```ts
  // §3.9: a sealed post's contentHash is frozen forever, so an edited post can
  // only match through the amendment that records the edit. Both are committed
  // to the chain, so accepting either introduces nothing unverified — while
  // accepting only the first makes editing any sealed post impossible.
  const amendments = getChain()
    .blocks.flatMap((b) => b.transactions)
    .filter((t) => t.type === 'amendment' && t.amends === tx.hash);
  const current = amendments[amendments.length - 1]?.contentHash ?? tx.contentHash;

  if (actual !== current) {
    throw new Error(
      `${path} does not match the chain: committed ${current.slice(0, 10)}…, ` +
        `on disk ${actual.slice(0, 10)}… — re-run \`npm run chain:build\` to record the edit as an amendment`,
    );
  }
  return { slug, body, contentHash: current, tx };
```

**Ordering matters:** amendments must be taken in chain order (block height, then position within the block), so the *latest* wins. `flatMap` over `getChain().blocks` preserves that order because the lock stores blocks ascending — confirm this by reading `getChain`, and if `getBlocks()` is newest-first, do **not** use it here.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/site/chain-data.test.ts -t 'amendment'`
Expected: PASS.

- [ ] **Step 5: Prove the whole flow end to end**

This is the actual deliverable, and a unit test cannot demonstrate it. In a **copy** of the repo outside the working tree:

```bash
SB=$(mktemp -d)
tar -c --exclude=node_modules --exclude=dist --exclude=.git . | tar -x -C "$SB"
ln -s "$PWD/node_modules" "$SB/node_modules"
cd "$SB"
printf '\nMột câu bổ sung.\n' >> content/posts/2026-06-15-genesis.md
npm run chain:build && npm run build
```

Expected: **both succeed.** Before this task, the second one fails. Paste the evidence into your report. Do not commit the sandbox, and leave the real working tree clean.

- [ ] **Step 6: Commit**

```bash
git add src/site/chain-data.ts tests/site/chain-data.test.ts
git commit -m "fix(site): accept a post body committed by an amendment"
```

---

### Task 3: Pending transactions carry their real hash

**Files:**
- Modify: `src/site/chain-data.ts`
- Test: `tests/site/chain-data.test.ts`

**Interfaces:**
- Consumes: `toTransaction(post, from, assets)` and `parsePost(path, raw)` from `src/chain/post.ts`; `identityAddress(handle)` from `src/chain/address.ts`; `hashAssetFile(assetsDir, file, path)` and `referencedAssets(body)` from `src/chain/asset.ts`; `CHAIN_CONFIG` from `chain.config.ts`.
- Produces:

```ts
export interface PendingBlockView {
  sealed: false;
  height: number;          // tip height + 1
  period: string;          // monthOf(now)
  transactions: Transaction[];
  txCount: number;
  gasUsed: number;         // sum over transactions
  value: number;           // sum over transactions
  isEmpty: boolean;
  maxTxPerBlock: number;   // for the "1/4 giao dịch" fill
  sealsOn: string;         // last calendar day of `period`, YYYY-MM-DD
}
export type AnyBlockView = (BlockView & { sealed: true }) | PendingBlockView;
export function getPendingBlock(now: string, postsDir?: string, assetsDir?: string): Promise<PendingBlockView | null>;
```

`BlockView` gains `sealed: true` in `toView`, so `AnyBlockView` discriminates cleanly.

- [ ] **Step 1: Write the failing test**

```ts
it('gives a pending post the same hash it will have once sealed', async () => {
  // The whole decision rests on this: sealing commits a hash into a Merkle
  // root, it does not create the hash. If these two differ, every pending
  // hash shown on the site is a lie that changes at month-end for no reason
  // the reader can see.
  const dir = mkdtempSync(join(tmpdir(), 'bc-pending-'));
  writeFileSync(
    join(dir, '2026-08-01-lazy.md'),
    '---\ntitle: Lazy propagation\ndate: 2026-08-01\ntags: [cp]\nresearch: 3.5\n---\n\nThân bài.\n',
  );
  const pending = await getPendingBlock('2026-08-02', dir);
  const viaEngine = await toTransaction(
    parsePost(join(dir, '2026-08-01-lazy.md'), readFileSync(join(dir, '2026-08-01-lazy.md'), 'utf8')),
    await identityAddress(CHAIN_CONFIG.authorHandle),
    [],
  );
  expect(pending!.transactions[0]!.hash).toBe(viaEngine.hash);
});

it('reports the open block one above the tip and seals at month end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bc-pending2-'));
  writeFileSync(join(dir, '2026-08-01-x.md'), '---\ntitle: X\ndate: 2026-08-01\ntags: [cp]\n---\n\nY.\n');
  const p = (await getPendingBlock('2026-08-02', dir))!;
  expect(p.height).toBe(getBlocks()[0]!.height + 1);
  expect(p.period).toBe('2026-08');
  expect(p.sealsOn).toBe('2026-08-31');   // February and leap years must work too
  expect(p.sealed).toBe(false);
});

it('returns null when every post on disk is already sealed', async () => {
  expect(await getPendingBlock('2026-08-02')).toBeNull();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/site/chain-data.test.ts -t 'pending'`
Expected: FAIL — `getPendingBlock` is synchronous and returns `PendingPost[]`.

- [ ] **Step 3: Implement**

Replace the body of `getPendingBlock`. Delete the `PendingPost` and `PendingBlock` interfaces — nothing else consumes them yet, which is the whole reason this task exists.

```ts
/** Last calendar day of `YYYY-MM`. Day 0 of the next month is the last of this one. */
function lastDayOf(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));   // month is 1-based here, so this is *this* month's end
  return d.toISOString().slice(0, 10);
}

export async function getPendingBlock(
  now: string,
  postsDir: string = POSTS_DIR,
  assetsDir: string = ASSETS_DIR,
): Promise<PendingBlockView | null> {
  const sealed = new Set(getPosts().map((t) => t.slug));
  const from = await identityAddress(CHAIN_CONFIG.authorHandle);

  const names = readdirSync(postsDir).filter((f) => f.endsWith('.md')).sort();
  const transactions: Transaction[] = [];
  for (const name of names) {
    const path = join(postsDir, name);
    const post = parsePost(path, readFileSync(path, 'utf8'));
    if (sealed.has(post.slug)) continue;
    const assets = [];
    for (const file of referencedAssets(post.body)) {
      assets.push(await hashAssetFile(assetsDir, file, path));
    }
    transactions.push(await toTransaction(post, from, assets));
  }
  if (transactions.length === 0) return null;

  // Same ordering rule the miner uses (§3.5): by date, ties by slug, so what
  // the site shows now is the order the block will actually seal in.
  transactions.sort((a, b) => a.date.localeCompare(b.date) || (a.slug ?? '').localeCompare(b.slug ?? ''));

  const period = now.slice(0, 7);
  return {
    sealed: false,
    height: (getBlocks()[0]?.height ?? -1) + 1,
    period,
    transactions,
    txCount: transactions.length,
    gasUsed: transactions.reduce((s, t) => s + t.gasUsed, 0),
    value: transactions.reduce((s, t) => s + t.value, 0),
    isEmpty: false,
    maxTxPerBlock: CHAIN_CONFIG.maxTxPerBlock,
    sealsOn: lastDayOf(period),
  };
}
```

`new Date(Date.UTC(...))` here is arithmetic on an explicit period, **not a clock read** — it never observes the current time. Keep the comment saying so, or a later reader will "fix" it.

- [ ] **Step 4: Add `sealed: true` to `toView`** in the same file, so `AnyBlockView` discriminates.

- [ ] **Step 5: Run the tests**

Run: `npm test` — expected PASS, including the determinism snapshot.

- [ ] **Step 6: Commit**

```bash
git add src/site/chain-data.ts tests/site/chain-data.test.ts
git commit -m "feat(site): build real transactions for the open block"
```

---

### Task 4: The pending treatment on the two components

**Design, already settled with the user — implement exactly this:**

- The open block shows **no** hash and **no** merkle root: `— chưa có, khối chưa đào`. They do not exist; a placeholder would be invented metadata.
- The stamp is **derived**, never hard-coded: sealed → `Sealed` in `--good`, solid border. Pending → `Chưa niêm phong` in `--warn`, dashed border.
- A pending transaction's hash carries a `~` prefix in `--warn` and drops to `--dim`.
- A state row sits under the card: `Đã băm → Chờ niêm phong`, with a trailing payload the caller supplies. On a block card that payload is `N/4 giao dịch` plus a four-segment fill and `· chốt <sealsOn>`. On a transaction page it is `sửa bài lúc này sẽ đổi hash, chưa sinh bản đính chính`.
- No work meter on a pending block — there is no nonce.

**Files:**
- Create: `src/components/PendingState.astro`
- Modify: `src/components/BlockCard.astro`, `src/components/TxPanel.astro`, `src/styles/chain.css`
- Test: `tests/site/pending-render.test.ts`

**Interfaces:**
- Consumes: `AnyBlockView`, `PendingBlockView` from Task 3.
- Produces: `<PendingState fill={string} segments={{ on: number; of: number } | null} />`.

- [ ] **Step 1: Write the failing test**

```ts
it('stamps a pending block differently from a sealed one', () => {
  expect(pendingHtml()).toContain('Chưa niêm phong');
  expect(pendingHtml()).not.toContain('Sealed');
  expect(sealedHtml()).toContain('Sealed');
});

it('shows no hash or nonce for a block that has not been mined', () => {
  // Not merely absent — explicitly marked, so a reader is not left wondering
  // whether the site failed to load it.
  expect(pendingHtml()).toContain('chưa có, khối chưa đào');
  expect(pendingHtml()).not.toMatch(/nonce/i);
});

it('marks a pending transaction hash as provisional', () => {
  expect(pendingHtml()).toContain('<span class="tilde">~</span>');
});

it('uses no hard-coded colour for either state', () => {
  const css = readFileSync('src/styles/chain.css', 'utf8');
  const added = css.slice(css.indexOf('.c-state'));
  expect(added).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
});
```

`pendingHtml()` / `sealedHtml()` must read from the **built** `dist/`, matching how the other site tests work — do not render components in isolation, since the bug class this guards against is wiring, not markup.

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/site/pending-render.test.ts`

- [ ] **Step 3: Create `src/components/PendingState.astro`**

```astro
---
interface Props { fill: string; segments: { on: number; of: number } | null }
const { fill, segments } = Astro.props;
---
<div class="c-state">
  <span class="c-step"><span class="b"></span>Đã băm</span>
  <span class="c-arrow">→</span>
  <span class="c-step todo"><span class="b"></span>Chờ niêm phong</span>
  <span class="c-fill">
    {fill}
    {segments ? (
      <span class="seg">
        {Array.from({ length: segments.of }, (_, i) => <s class={i < segments.on ? 'on' : ''}></s>)}
      </span>
    ) : null}
  </span>
</div>
```

- [ ] **Step 4: Add the styles** to `src/styles/chain.css`, tokens only:

```css
.a-hash { color: var(--dim); }
.a-hash .tilde { color: var(--warn); font-weight: 700; }
.stamp.open { color: var(--warn); border-color: var(--warn); border-style: dashed; }
.gutter .dot.open { border-style: dashed; border-color: var(--warn); }
.c-state { display: flex; flex-wrap: wrap; gap: 0.4rem 0.55rem; align-items: center;
  font-family: var(--mono); font-size: 0.64rem; letter-spacing: 0.09em; text-transform: uppercase;
  margin-top: 0.8rem; padding-top: 0.7rem; border-top: 1px solid var(--line); }
.c-step { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--good); }
.c-step.todo { color: var(--dim); }
.c-step .b { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--good); }
.c-step.todo .b { background: none; border: 1.5px solid var(--dim); }
.c-arrow { color: var(--line2); }
.c-fill { margin-left: auto; color: var(--dim); text-transform: none; letter-spacing: 0.04em; }
.seg { display: inline-flex; gap: 2px; margin-left: 0.4rem; vertical-align: -1px; }
.seg s { width: 0.5rem; height: 0.5rem; background: var(--line2); border-radius: 1px; display: block; }
.seg s.on { background: var(--acc); }
```

- [ ] **Step 5: Wire both components.** `BlockCard` takes `AnyBlockView` and branches on `block.sealed`; `TxPanel` takes an added `pending: boolean` prop. Keep every existing sealed-path assertion passing.

- [ ] **Step 6: Run the full suite, then commit**

```bash
git add src/components src/styles/chain.css tests/site/pending-render.test.ts
git commit -m "feat(site): render the open block and its provisional hashes"
```

---

### Task 5: Pending posts get pages

**Files:**
- Modify: `src/pages/tx/[slug].astro`, `src/pages/index.astro`
- Test: `tests/site/post-page.test.ts`

- [ ] **Step 1: Write the failing test** — a post on disk in the open month has a page at `/tx/<slug>`, its panel links to the open block, and its stamp reads `Chưa niêm phong`.

- [ ] **Step 2: Run and confirm failure** (no such page is generated).

- [ ] **Step 3: Implement.** `getStaticPaths` becomes async and concatenates sealed posts with `(await getPendingBlock(NOW))?.transactions ?? []`, passing `pending: true` for the latter. `NOW` must come from the same injected build-time value the rest of the site uses — **find it and reuse it; do not call `new Date()`.**

**Watch:** `getPostContent` verifies against the chain, and a pending post is not in the lock. It must still verify — against the transaction Task 3 just built, whose `contentHash` came from the same file. Do not skip the check for pending posts; that would be a hole in the guarantee Task 2 exists to protect.

- [ ] **Step 4: Run the suite.** Expected PASS, including `build-guarantees.test.ts`.

- [ ] **Step 5: Commit** — `feat(site): give unsealed posts their own page`

---

### Task 6: `/blocks`, `/block/[height]`, and 404

**Files:**
- Create: `src/pages/blocks.astro`, `src/pages/block/[height].astro`, `src/pages/404.astro`
- Test: `tests/site/block-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('lists every block newest first, including the open one', () => { /* … */ });
it('gives each sealed block a detail page at /block/<height>', () => { /* … */ });
it('shows the full hash on a block detail page and a truncated one in the list', () => {
  // Spec §3.2 as amended: truncated where hashes are scanned, full where the
  // page exists to be verified from.
});
it('has a 404 page that links back to the chain', () => { /* … */ });
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement,** reusing `BlockCard`. `/block/[height]` renders one block with its full hash, merkle root, nonce, work meter, and transaction list.
- [ ] **Step 4: Run the suite and the build.**
- [ ] **Step 5: Commit** — `feat(site): add the block list, block pages and 404`

---

## Self-Review

**Spec coverage.** §3.6 open block → Tasks 1, 3, 4. §3.9 amendments → Task 2. §3.2 hash display → Task 6. §6 block pages → Task 6. §9 visual direction → Task 4. §14 committed fields only → Task 4's "no invented placeholder" rule. Addresses, assets, mempool, RSS and `/contracts` are explicitly out of scope above, not omissions.

**Known gap carried forward.** `summary` is still parsed from frontmatter and hashed nowhere. No task here displays it. If Plan 2b-iii puts it on a listing page, it must not sit next to a hash as though committed.

**Type consistency.** `PendingBlockView.sealed: false` and `BlockView.sealed: true` discriminate `AnyBlockView` (Task 3), consumed under those exact names in Tasks 4–6. `getPendingBlock` is async from Task 3 onward — every later caller awaits it.

**Risk flagged for the implementer of Task 1.** Changing `fromPeriod` alters where transactions land. If the determinism snapshot changes, that is a signal, not a chore — stop and report rather than re-recording it.
