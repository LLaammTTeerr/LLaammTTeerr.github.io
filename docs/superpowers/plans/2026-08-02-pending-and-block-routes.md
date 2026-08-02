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

### Task 1: The open block's period is recorded, not recomputed

**This task merges what were Tasks 1 and 2.** They cannot be separated: splitting them leaves the chain in a state where a partial block *never seals at any clock*, which was measured, not predicted.

**The bug being fixed.** With the tip at `2026-07` and the clock in `2026-08`, editing a sealed post mints a *second* `2026-07` block — a month that already closed — instead of joining the open `2026-08` one. §3.6: "Block membership is when a transaction entered the chain, not the date it claims."

**Why the obvious fix fails, twice.** `firstOpenPeriod` in `planBlocks` does two jobs:

1. `monthRange(firstOpenPeriod, endExclusive)` — the months walked, which mints empty blocks for silent months.
2. the floor for placing a transaction.

Raising **both** skips silent months, so they never mint their empty blocks: permanent gaps. Only role 2 may move — but moving role 2 alone produces this, measured over successive builds with one pending transaction:

```
tip=2026-07 now=2026-08-10 -> 2026-07[0]             | still pending
tip=2026-07 now=2026-09-10 -> 2026-07[0] 2026-08[0]  | still pending
tip=2026-08 now=2026-10-10 -> 2026-08[0] 2026-09[0]  | still pending
```

The transaction slides forward forever. Each build recomputes its placement against the *then*-current month, which is never `isPast`, so the month-end rule (`isFull || isPast`) can never fire — only the size rule survives. Worse, each month mints an **empty** block while actually holding a pending transaction, so the chain records months as silent that were not.

**The fix.** Placement must be a *recorded fact*, assigned once when a transaction first enters the chain and persisted in `chain.pending.json`. A transaction already recorded as belonging to `2026-07` keeps `2026-07`; when that month becomes past, its block seals normally. Only genuinely new transactions get the current month. This is also what makes a pending hash verifiable rather than merely recalculated, and what Task 3 needs for the drift check.

The sealed ledger stays pristine — `chain.lock.json` remains immutable sealed history; the churn lives in a sibling file that is openly provisional.

**Files:**
- Create: `src/chain/pending.ts`
- Modify: `src/chain/seal.ts` (`planBlocks`, `PlanOptions`), `src/chain/build.ts`
- Test: `tests/chain/pending.test.ts`, `tests/chain/seal.test.ts`, `tests/chain/build.test.ts`

**Interfaces produced:**

```ts
export interface PendingLock {
  version: 1;
  period: string;          // YYYY-MM — the recorded placement, which does not slide
  height: number;          // the height this block will take once sealed
  prevHash: Hex;           // the tip's hash when written; makes staleness detectable
  transactions: Transaction[];
}
export const PENDING_PATH = 'chain.pending.json';
export function readPending(path: string): PendingLock | null;   // null on missing/corrupt/wrong-version
export function writePending(path: string, pending: PendingLock | null): void;  // null DELETES the file
export function isStale(pending: PendingLock, tipHash: Hex): boolean;
```

`PlanOptions` gains `recordedPeriods?: ReadonlyMap<Hex, string>` — transaction hash to its already-recorded period.

- [ ] **Step 1: Keep the placement/walk split already in the working tree.** It is correct and its regression guards pass. Do not revert it.

- [ ] **Step 2: Write the failing test that proves a recorded placement seals**

```ts
it('seals a block whose recorded period has ended, even with a partial group', () => {
  // The month-end rule must fire for 1-3 transactions. Without recorded
  // placement this is unreachable at ANY clock: the transaction is re-placed
  // into the current month on every build and the current month is never past.
  const t = tx('2026-07-05', 'p');
  const drafts = planBlocks([t], {
    now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07',
    recordedPeriods: new Map([[t.hash, '2026-07']]),
  });
  const withTxs = drafts.filter((d) => d.transactions.length > 0);
  expect(withTxs.map((d) => d.period)).toEqual(['2026-07']);
});

it('does not mint an empty block for a month that held a pending transaction', () => {
  const t = tx('2026-07-05', 'p');
  const drafts = planBlocks([t], {
    now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07',
    recordedPeriods: new Map([[t.hash, '2026-07']]),
  });
  expect(drafts.filter((d) => d.period === '2026-07' && d.transactions.length === 0)).toEqual([]);
});

it('gives a genuinely new transaction the current month, not its claimed date', () => {
  const t = tx('2026-06-15', 'backdated');
  const drafts = planBlocks([t], { now: '2026-08-10', maxTxPerBlock: 4, fromPeriod: '2026-07' });
  expect(drafts.filter((d) => d.transactions.length > 0).map((d) => d.period)).not.toContain('2026-07');
});
```

- [ ] **Step 3: Run and confirm the first two fail** for the reason above (`recordedPeriods` is not a known option).

- [ ] **Step 4: Use it in the bucketing loop.** A recorded period wins, but is still floored by `firstOpenPeriod` so it can never reopen a sealed month:

```ts
    const recorded = opts.recordedPeriods?.get(tx.hash);
    const period = recorded !== undefined
      ? maxPeriod(recorded, firstOpenPeriod)
      : minPeriod(maxPeriod(monthOf(tx.date), membershipFloor), latestOpenPeriod);
```

- [ ] **Step 5: Implement `src/chain/pending.ts`.** Validate on read the way `readLock` does — a malformed or wrong-version file returns `null` rather than throwing, because a corrupt provisional file must never take the build down. Match the lock's serialization conventions (stable key order, 2-space indent, trailing newline).

- [ ] **Step 6: Wire `build.ts`.** Read `chain.pending.json` before planning; if `isStale` against the current tip, ignore it. Feed its transactions' periods in as `recordedPeriods`. After the sealing loop, write the still-unsealed transactions back with `prevHash` = the final tip's hash. Report the pending count in the build summary beside `sealed` and `amendments`.

- [ ] **Step 7: Rewrite the `build.test.ts` assertions that encode the old timing.** `BuildResult.amendments` counts amendments *sealed*, so an amendment that stays pending makes it `0`. That is now correct. Where a test's real subject is the amendment's content (title, research figure, gas, asset minting), assert against the **pending block** instead of deleting the coverage — `BuildResult` should expose it. Report every test you touched and why.

- [ ] **Step 8: Prove the whole cycle end to end** in a **copy** of the repo outside the working tree:

```bash
SB=$(mktemp -d)
tar -c --exclude=node_modules --exclude=dist --exclude=.git . | tar -x -C "$SB"
ln -s "$PWD/node_modules" "$SB/node_modules"
cd "$SB"
printf '\nMột câu bổ sung.\n' >> content/posts/2026-06-15-genesis.md
npm run chain:build          # amendment lands in chain.pending.json
cat chain.pending.json
git diff --stat chain.lock.json   # must be EMPTY — sealed history untouched
```

Then prove the month-end rule now fires: run `chain:build` again with an injected clock in the following month and show the pending block **seals**, carrying its recorded period. That is the behaviour whose absence blocked this task twice; demonstrate it rather than asserting it.

- [ ] **Step 9: Full suite, typecheck, then commit**

```bash
git add src/chain tests/chain chain.pending.json
git commit -m "feat(chain): record the open block so its placement stops sliding"
```

**If the determinism golden-file snapshot changes, STOP and report** — do not re-record it.

---

### Task 2: The site reads the recorded open block

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

### Task 3: Editing a sealed post must not brick the build

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

**Spec coverage.** §3.6 open block → Tasks 1, 2. §3.9 amendments → Tasks 1, 3. §3.2 hash display → Task 6. §6 block pages → Task 6. §9 visual direction → Task 4. §14 committed fields only → Task 4's "no invented placeholder" rule. Addresses, assets, mempool, RSS and `/contracts` are explicitly out of scope above, not omissions.

**Known gap carried forward.** `summary` is still parsed from frontmatter and hashed nowhere. No task here displays it. If Plan 2b-iii puts it on a listing page, it must not sit next to a hash as though committed.

**Type consistency.** `PendingBlockView.sealed: false` and `BlockView.sealed: true` discriminate `AnyBlockView` (Task 3), consumed under those exact names in Tasks 4–6. `getPendingBlock()` takes no arguments and is synchronous from Task 3 onward, because it reads a recorded file rather than rebuilding from disk.

**Risk flagged for the implementer of Task 1.** Changing `fromPeriod` alters where transactions land. If the determinism snapshot changes, that is a signal, not a chore — stop and report rather than re-recording it.
