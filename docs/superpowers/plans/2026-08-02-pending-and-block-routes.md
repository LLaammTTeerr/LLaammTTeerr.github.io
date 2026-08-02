# Pending Transactions and Block Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a post published into the current, unsealed month a first-class citizen of the site — real hash, real page, real URL — and give the chain the block-browsing routes it has been missing.

**Architecture:** `npm run chain:build` gains a second output, `chain.pending.json`, recording the open block — real transactions with real hashes, including amendments awaiting the next seal. The site reads that file instead of recomputing pending state from disk, which is what makes a pending hash verifiable rather than merely recalculated, and what lets the drift check ask the question it actually needs to ask: *does this body match what `chain:build` last recorded?* Sealed and pending blocks then share one view type discriminated by a `sealed` boolean, letting `BlockCard` render both.

**Revised 2026-08-03.** The first attempt at Task 1 was blocked, correctly. `firstOpenPeriod` does two jobs in `planBlocks` — it starts the month walk that mints empty blocks for silent months, and it floors where transactions may land. Raising both created permanent chain gaps. Separating them is right, but it also stops amendments sealing on the spot, which is what §3.9 wants and what broke the original Task 2: a pending amendment is not in the lock, so reading amendments from `getChain()` cannot see it. Hence the new file. Task numbering below reflects the revision.

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

**In:** the sealing-placement bug, the recorded open block, the edit dead end, pending transactions with real hashes, the C+A pending treatment on `BlockCard` and `TxPanel`, `/blocks`, `/block/[height]`, `/404`.

**Out, deferred to Plan 2b-iii:** `/address/[name]`, `/about`, `/assets`, `/asset/[tokenId]`, `/mempool`. Deferred to 2b-iv: RSS, `/contracts`. This plan is everything about *blocks*; addresses and assets are a separate subsystem with their own data shapes.

## File Structure

| File | Responsibility |
|---|---|
| `src/chain/seal.ts` (modify) | Separate the month-walk start from the transaction membership floor |
| `src/chain/pending.ts` (create) | Read/write `chain.pending.json`; shape, validation, staleness |
| `src/chain/build.ts` (modify) | Emit `chain.pending.json` beside the lock |
| `chain.pending.json` (generated, committed) | The open block: period, tip hash, real transactions |
| `src/site/chain-data.ts` (modify) | `getPendingBlock` reads the pending file; `getPostContent` accepts a body recorded there; `PendingBlockView` |
| `src/components/PendingState.astro` (create) | The C+A state row, one component, caller supplies the trailing payload |
| `src/components/BlockCard.astro` (modify) | Renders sealed and pending blocks; stamp and meter become conditional |
| `src/components/TxPanel.astro` (modify) | `~` prefix, derived stamp, block link for pending transactions |
| `src/pages/tx/[slug].astro` (modify) | `getStaticPaths` includes pending posts |
| `src/pages/blocks.astro` (create) | Full block list |
| `src/pages/block/[height].astro` (create) | One block's detail page |
| `src/pages/404.astro` (create) | Not-found page |
| `src/styles/chain.css` (modify) | `.a-hash`, `.c-state` and pending card styles |

---

### Task 1: Separate the month walk from the membership floor

**Why this is first:** with the tip at `2026-07` and the clock in `2026-08`, editing a sealed post mints a *second* `2026-07` block — a month that already closed — instead of joining the open `2026-08` one. Spec §3.6: "Block membership is when a transaction entered the chain, not the date it claims."

**A previous attempt at this task was blocked, correctly. Read this before you start.** `firstOpenPeriod` in `planBlocks` is used for two different things:

1. `monthRange(firstOpenPeriod, endExclusive)` — the months to walk, which is what mints empty blocks for silent months.
2. `minPeriod(maxPeriod(monthOf(tx.date), firstOpenPeriod), latestOpenPeriod)` — the floor for placing a transaction.

Raising **both** (the obvious fix, and the one the earlier attempt was told to make) skips silent months between the tip and now, so they never mint their empty blocks — permanent gaps in the chain. Only role 2 may move.

**Files:**
- Modify: `src/chain/seal.ts` (`planBlocks`)
- Test: `tests/chain/seal.test.ts`

**Interfaces:**
- Consumes: `monthOf`, `minPeriod`, `maxPeriod`, `monthRange`, `nextMonth` from `src/chain/period.ts`; `PlanOptions` with `fromPeriod: string | null`.
- Produces: no signature change. Behaviour change only. `build.ts` is **not** modified by this task.

- [ ] **Step 1: Write the failing tests**

The existing helper in this file is `tx(date, slug)` — there is **no** `txFixture()`. Check its real signature before using it.

```ts
it('places a transaction entering the chain today in the open month, not the tip month', () => {
  // Tip 2026-07 is sealed; an amendment carrying an old date enters on 2026-08-02.
  const drafts = planBlocks([tx('2026-06-15', 'old')], {
    now: '2026-08-02', maxTxPerBlock: 4, fromPeriod: '2026-07',
  });
  const withTxs = drafts.filter((d) => d.transactions.length > 0);
  expect(withTxs.map((d) => d.period)).not.toContain('2026-07');
});

it('still mints empty blocks for silent months between the tip and now', () => {
  // The regression that blocked the first attempt. Tip 2026-05, clock 2026-08:
  // 2026-06 and 2026-07 were silent but complete, so each must still get its
  // block. A month with no block is not "closed" — it is a hole in the chain.
  const drafts = planBlocks([tx('2026-06-15', 'old')], {
    now: '2026-08-02', maxTxPerBlock: 4, fromPeriod: '2026-05',
  });
  expect(drafts.map((d) => d.period)).toEqual(
    expect.arrayContaining(['2026-05', '2026-06', '2026-07']),
  );
});

it('still lets a busy current month split into two blocks of the same period', () => {
  // 8, not 5: a PARTIAL group in the open month stays pending (see the
  // `isFull || isPast` rule below), so 5 transactions yield ONE block. Eight
  // is the smallest input that actually produces two full groups.
  const many = Array.from({ length: 8 }, (_, i) =>
    tx(`2026-08-${String(i + 1).padStart(2, '0')}`, `p${i}`));
  const drafts = planBlocks(many, { now: '2026-08-20', maxTxPerBlock: 4, fromPeriod: '2026-08' });
  expect(drafts.filter((d) => d.period === '2026-08').length).toBe(2);
});
```

- [ ] **Step 2: Run and confirm each fails for its own reason**

Run: `npx vitest run tests/chain/seal.test.ts`
Expected: test 1 FAILS (the transaction lands in `2026-07`). Tests 2 and 3 should **already pass** — they are regression guards for behaviour you must not break. If either fails now, stop and report: the baseline is not what this plan assumes.

- [ ] **Step 3: Implement in `planBlocks`**

Leave `firstOpenPeriod` and the `monthRange(firstOpenPeriod, endExclusive)` walk exactly as they are. Add, directly after `latestOpenPeriod`:

```ts
  // Where a transaction ENTERING the chain now may land, as distinct from the
  // months this build walks. The walk must still start at the tip so silent
  // completed months mint their empty blocks (§3.6); placement must not, or a
  // month that already sealed would quietly gain a transaction afterwards.
  //
  // On an empty chain there is no tip and genesis bootstraps at the earliest
  // transaction's own month, so the floor stays where `firstOpenPeriod` put it.
  const membershipFloor =
    opts.fromPeriod === null ? firstOpenPeriod : maxPeriod(firstOpenPeriod, currentPeriod);
```

Then in the bucketing loop only, replace `firstOpenPeriod` with `membershipFloor`:

```ts
    const period = minPeriod(maxPeriod(monthOf(tx.date), membershipFloor), latestOpenPeriod);
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`

**Expect failures in `tests/chain/build.test.ts`, and do not "fix" them by editing assertions.** Amendments now stay in the open block instead of sealing immediately — that is the intended change, and Task 2 is what makes it usable. Report exactly which tests fail and what each asserted. Tests that assert `amendments === 1` encode the old behaviour and need rewriting to assert the amendment is *pending*; do that only where the assertion is plainly about sealing timing. **If the determinism golden-file snapshot changes, STOP and report** — do not re-record it.

- [ ] **Step 5: Commit**

```bash
git add src/chain/seal.ts tests/chain/seal.test.ts tests/chain/build.test.ts
git commit -m "fix(chain): place entering transactions in the open month, keep minting silent ones"
```

---

### Task 2: Record the open block in `chain.pending.json`

**Why:** everything unsealed is currently recomputed from disk on every build, so disk can never disagree with it — which is exactly why the drift check cannot catch an edit to an unsealed post, and why a pending hash today is merely recalculated rather than verifiable. Recording the open block to a committed file makes it real: the site reads what `chain:build` wrote, and an edit shows up as a diff.

The sealed ledger stays pristine. `chain.lock.json` remains an immutable record of sealed history; the churn lives in a sibling file that is openly provisional.

**Files:**
- Create: `src/chain/pending.ts`
- Modify: `src/chain/build.ts`
- Test: `tests/chain/pending.test.ts`

**Interfaces:**
- Consumes: `Transaction`, `Hex` from `./types`; `planBlocks` from `./seal`; the lock's serialization conventions in `src/chain/lock.ts` (read `writeLock`/`readLock` and match their style — stable key order, trailing newline, 2-space indent).
- Produces:

```ts
export interface PendingLock {
  version: 1;
  period: string;          // YYYY-MM
  height: number;          // the height this block will take once sealed
  prevHash: Hex;           // the tip's hash when this was written
  transactions: Transaction[];
}
export const PENDING_PATH = 'chain.pending.json';
export function readPending(path: string): PendingLock | null;
export function writePending(path: string, pending: PendingLock | null): void;
```

`writePending(path, null)` **deletes** the file — an empty open block must not leave a stale one behind.

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips a pending block through the file', () => { /* write then read, deep equal */ });

it('reports a pending file as stale when the tip has moved on', () => {
  // prevHash is what makes the file honest. Without it a pending block written
  // against one history could be displayed against another, and the hashes
  // would be real but attached to the wrong chain.
  const stale = { ...fixture(), prevHash: '0x' + 'ff'.repeat(32) };
  expect(isStale(stale, tipHash)).toBe(true);
});

it('deletes the file rather than leaving a stale open block', () => {
  writePending(path, fixture());
  writePending(path, null);
  expect(existsSync(path)).toBe(false);
});

it('returns null rather than throwing on a corrupt file', () => {
  writeFileSync(path, '{ not json');
  expect(readPending(path)).toBeNull();
});
```

- [ ] **Step 2: Run and confirm failure.** Run: `npx vitest run tests/chain/pending.test.ts`

- [ ] **Step 3: Implement `src/chain/pending.ts`.** Validate on read the way `readLock` does — a malformed or wrong-version file returns `null` rather than throwing, because a corrupt provisional file must never take the build down.

- [ ] **Step 4: Emit it from `build.ts`.** After the sealing loop, the transactions that `planBlocks` left unsealed are the open block. Write them with `prevHash` = the final tip's hash and `height` = tip height + 1. Report the count in the build summary alongside `sealed` and `amendments`, so running `chain:build` tells you what is waiting.

- [ ] **Step 5: Prove the end-to-end flow.** In a **copy** of the repo outside the working tree:

```bash
SB=$(mktemp -d)
tar -c --exclude=node_modules --exclude=dist --exclude=.git . | tar -x -C "$SB"
ln -s "$PWD/node_modules" "$SB/node_modules"
cd "$SB"
printf '\nMột câu bổ sung.\n' >> content/posts/2026-06-15-genesis.md
npm run chain:build
cat chain.pending.json
```

Expected: the amendment appears in `chain.pending.json`, and `chain.lock.json` is **unchanged** (`git diff --stat chain.lock.json` empty). Paste both into your report. Leave the real working tree clean.

- [ ] **Step 6: Commit**

```bash
git add src/chain/pending.ts src/chain/build.ts tests/chain/pending.test.ts chain.pending.json
git commit -m "feat(chain): record the open block in chain.pending.json"
```

---

### Task 3: The site reads the recorded open block

**Files:**
- Modify: `src/site/chain-data.ts`
- Test: `tests/site/chain-data.test.ts`

**Interfaces:**
- Consumes: `readPending`, `PENDING_PATH`, `PendingLock` from `src/chain/pending.ts`.
- Produces:

```ts
export interface PendingBlockView {
  sealed: false;
  height: number;
  period: string;
  transactions: Transaction[];
  txCount: number;
  gasUsed: number;         // sum over transactions
  value: number;           // sum over transactions
  maxTxPerBlock: number;   // for the "1/4 giao dịch" fill
  sealsOn: string;         // last calendar day of `period`, YYYY-MM-DD
}
export type AnyBlockView = (BlockView & { sealed: true }) | PendingBlockView;
export function getPendingBlock(): PendingBlockView | null;
```

`getPendingBlock` takes **no arguments** now. It reads a recorded file; it does not need `now`, and must not read the clock. Delete the old `PendingPost` and `PendingBlock` interfaces and the disk-walking implementation — nothing consumes them.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns null when no pending file exists', () => { /* … */ });

it('exposes the recorded transactions with their recorded hashes', () => {
  // Not recomputed. The point of the file is that the site shows what
  // chain:build committed, so a hash on the page is one you can diff.
});

it('refuses a pending file written against a different tip', () => {
  // A stale file must not render as though it belonged to this chain.
});

it('reports the month end as the seal date', () => {
  expect(getPendingBlock()!.sealsOn).toBe('2026-08-31');   // February and leap years too
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Deep-freeze what you return, as `getChain` does. `sealsOn` is arithmetic on the recorded period string — `new Date(Date.UTC(y, m, 0))` reads no clock, and say so in a comment or someone will "fix" it later.
- [ ] **Step 4: Add `sealed: true` to `toView`** so `AnyBlockView` discriminates.
- [ ] **Step 5: Run the suite, then commit** — `feat(site): read the recorded open block`

---

### Task 4: Editing a sealed post must not brick the build

**Why:** the current behaviour is a closed loop. Edit a sealed post → the site build fails with *"re-run `npm run chain:build` to record the edit as an amendment"* → you run it, it records the amendment → **the build fails with the identical message, forever.** `getPostContent` compares the file on disk against the *sealed* transaction's `contentHash`, which by design never changes.

With Tasks 1–3 done the amendment is recorded in `chain.pending.json`, so the check can finally ask the right question: does this body match what `chain:build` last recorded — whether that was a sealed transaction or a pending amendment? Both are recorded, committed values, so nothing unverified is admitted.

**Files:**
- Modify: `src/site/chain-data.ts` (`getPostContent`)
- Test: `tests/site/chain-data.test.ts`, `tests/site/build-guarantees.test.ts`

- [ ] **Step 1: Write the failing test** — a body matching a pending amendment's `contentHash` is accepted; a body matching **neither** the sealed nor the pending hash is still rejected with the existing message. The second half is the guarantee; do not lose it.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement.** Accept the body if its hash equals the sealed `contentHash`, or the `contentHash` of the latest amendment to this post — searching the pending block first, then sealed blocks in chain order so the most recent wins. Return the hash that actually matched as `PostContent.contentHash`.

- [ ] **Step 4: Prove the flow end to end** in a sandbox copy, exactly as in Task 2 but continuing to `npm run build`:

```bash
printf '\nMột câu bổ sung.\n' >> content/posts/2026-06-15-genesis.md
npm run chain:build && npm run build
```

Expected: **both succeed.** Before this task the second fails. This is the deliverable; paste the evidence.

- [ ] **Step 5: Confirm the guarantee still bites.** `tests/site/build-guarantees.test.ts` must still fail the build for a body edited *without* running `chain:build`. Run it and say so explicitly in your report — a fix that accepts every body would pass Step 4 and be worthless.

- [ ] **Step 6: Commit** — `fix(site): accept a post body recorded by an amendment`

---

### Task 5: The pending treatment on the two components

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

### Task 6: Pending posts get pages

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

### Task 7: `/blocks`, `/block/[height]`, and 404

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

**Spec coverage.** §3.6 open block → Tasks 1, 2, 3. §3.9 amendments → Tasks 1, 2, 4. §3.2 hash display → Task 6. §6 block pages → Task 6. §9 visual direction → Task 4. §14 committed fields only → Task 4's "no invented placeholder" rule. Addresses, assets, mempool, RSS and `/contracts` are explicitly out of scope above, not omissions.

**Known gap carried forward.** `summary` is still parsed from frontmatter and hashed nowhere. No task here displays it. If Plan 2b-iii puts it on a listing page, it must not sit next to a hash as though committed.

**Type consistency.** `PendingBlockView.sealed: false` and `BlockView.sealed: true` discriminate `AnyBlockView` (Task 3), consumed under those exact names in Tasks 4–6. `getPendingBlock()` takes no arguments and is synchronous from Task 3 onward, because it reads a recorded file rather than rebuilding from disk.

**Risk flagged for the implementer of Task 1.** Changing `fromPeriod` alters where transactions land. If the determinism snapshot changes, that is a signal, not a chore — stop and report rather than re-recording it.
