# Addresses, Assets and the Mempool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chain its remaining first-class nouns — addresses that receive transactions, minted assets, the author's own address page, and a mempool of drafts — so every link the site already renders resolves to something real.

**Architecture:** Each route reads the committed ledger through `src/site/chain-data.ts` and nothing else. Addresses and assets are derived *views* over transactions already on the chain, not new stored state, so no engine change is needed. Drafts are the exception and are deliberately outside the chain: they carry no hash and must never be dressed as though they do.

**Tech Stack:** Astro 7 static output, TypeScript, Vitest. No new dependencies.

## Global Constraints

- **No module under `src/site/` may read the clock.** `now` is always an injected `YYYY-MM-DD` parameter. A golden-file snapshot test guards determinism.
- **`verifyChain` must never throw** on untrusted input, for any input.
- **`verify.ts` and its transitive import closure** (`canonical.ts`, `hash.ts`, `merkle.ts`, `types.ts`) must never reach a Node built-in or a bare package specifier — it runs in the browser. An import-graph test guards this.
- **Sealed blocks are frozen.** `chain.lock.json` is never rewritten for an existing block, and no task here regenerates it.
- **No hard-coded colours.** Eleven reader-selectable palettes; every colour resolves through a token in `src/styles/tokens.css`. A literal hex is wrong in ten of them, and a test asserts this over the whole stylesheet.
- **Explorer chrome is English; all author-facing content is Vietnamese.** Match the Vietnamese already in the components.
- **`noUncheckedIndexedAccess: true`.** Indexing an array yields `T | undefined`.
- **Hash display:** truncated with a middle ellipsis in lists, in full on a record's own detail page (§3.2, amended 2026-08-02).
- **Every displayed field must be a committed one (§14).** If a value is derived, re-derive it from something committed — never fall back to a recorded-but-unverified number. If it cannot be derived, omit it the way the open block omits a hash it has not mined.
- **`src/site/routes.ts` holds one `built` flag per route.** A route that does not exist renders as plain text, not a link. Each task flips its own flag, so the branch never ships a dead link.
- `npm run typecheck` runs `tsc --noEmit && astro check`; both must pass.

## Scope

**In:** `/address/[name]`, `/about` (and `/address/lamter.eth`), `/mempool`, `/assets`, `/asset/[tokenId]`.

**Out, deferred:** `/contracts` and `/contract/[name]` (they need `content/contracts/`, a separate content type), RSS, `/verify`'s interactive UI, `/chain.json`, search. Those are Plan 2b-iv and Plan 3.

## File Structure

| File | Responsibility |
|---|---|
| `src/site/addresses.ts` (create) | Derive address views from chain transactions: name ↔ address, received transactions, totals, first/last seen |
| `src/pages/address/[name].astro` (create) | A tag or series address page |
| `src/pages/about.astro` (create) | The author's address page; `/address/lamter.eth` redirects here in content, not HTTP |
| `content/profile.md` (create) | The author's bio and links — **content, filled by the author** |
| `src/site/drafts.ts` (create) | Read `content/drafts/`; deliberately chain-free |
| `src/pages/mempool.astro` (create) | Drafts as unconfirmed, un-hashed work |
| `src/site/assets-view.ts` (create) | Asset views: which transactions reference a token, re-derived byte size and hash |
| `src/pages/assets.astro`, `src/pages/asset/[tokenId].astro` (create) | Gallery and detail |
| `src/styles/chain.css` (modify) | Styles for the new list and detail shapes |
| `src/site/routes.ts` (modify) | Flip `built` per route as each lands |

---

### Task 1: Address views and `/address/[name]`

**Why first:** every post page already names its tags, and those names are currently plain text because the route does not exist. This is the most-linked missing page.

**Spec:** §3.7 — an address is `0x` + the first 40 hex of `sha256("addr/1|tag|" + slug)`, and every address resolves to a name (`cp.tag`, `blockchain.tag`). §3.8 — an address page shows **total value received**, which is a genuine measure of effort spent on that topic.

**Files:**
- Create: `src/site/addresses.ts`, `src/pages/address/[name].astro`
- Modify: `src/site/routes.ts`, `src/components/TxPanel.astro` (tags become links again)
- Test: `tests/site/addresses.test.ts`

**Interfaces:**
- Consumes: `tagAddress(slug)`, `tagName(slug)` from `src/chain/address.ts`; `getPosts()`, `getBlocks()`, `getPendingBlock()` from `src/site/chain-data.ts`.
- Produces:

```ts
export interface AddressView {
  name: string;        // "cp.tag" | "ghi-chu.series"
  slug: string;        // "cp"
  kind: 'tag' | 'series';
  address: Hex;        // 0x + 40 hex
  transactions: Transaction[];  // newest first
  txCount: number;
  valueReceived: number;        // sum of `value` over received posts, §3.8
  firstSeen: string;            // YYYY-MM-DD of the earliest, from committed `date`
  lastSeen: string;
}
export function getAddresses(): AddressView[];              // every address on the chain
export function getAddress(name: string): AddressView | undefined;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('derives a tag address that matches the engine', async () => {
  // The site must not reimplement address derivation — if these ever disagree,
  // the page shows an address the chain does not know.
  const view = getAddress('meta.tag')!;
  expect(view.address).toBe(await tagAddress('meta'));
});

it('lists every post that sent to the address, newest first', () => {
  const view = getAddress('meta.tag')!;
  const dates = view.transactions.map((t) => t.date);
  expect([...dates].sort().reverse()).toEqual(dates);
  expect(view.transactions.every((t) => t.tags.includes('meta'))).toBe(true);
});

it('sums only value actually received', () => {
  // Not the whole chain's value: an address receives from its own posts only.
  const view = getAddress('meta.tag')!;
  const expected = getPosts()
    .filter((t) => t.tags.includes('meta'))
    .reduce((s, t) => s + t.value, 0);
  expect(view.valueReceived).toBeCloseTo(expected, 5);
  expect(view.valueReceived).not.toBeCloseTo(getStats().totalValue ?? -1, 5);
});

it('has no page for a name no post ever sent to', () => {
  expect(getAddress('khong-ton-tai.tag')).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm each fails** for its own reason. Run: `npx vitest run tests/site/addresses.test.ts`

- [ ] **Step 3: Implement `src/site/addresses.ts`.** Derive from `getPosts()` plus the open block's post transactions, so a tag first used this month has a page immediately. Address derivation must call `tagAddress` — do not reimplement the hash.

- [ ] **Step 4: Build the route.** `getStaticPaths` from `getAddresses()`. Note the route param contains a dot (`meta.tag`); confirm Astro emits `dist/address/meta.tag/index.html` and that the link-integrity test's resolver treats it as a route, not a file — that exact blind spot hid a dead link on this project before.

- [ ] **Step 5: Flip `address` to `built: true` in `src/site/routes.ts`** and restore `TxPanel`'s tag/series links.

- [ ] **Step 6: Run the suite and the link-integrity test.** Every link in every built page must resolve. Then commit:

```bash
git add src/site/addresses.ts src/pages/address src/site/routes.ts src/components/TxPanel.astro tests/site/addresses.test.ts
git commit -m "feat(site): add tag and series address pages"
```

---

### Task 2: The author's address page and `/about`

**Spec:** §3.7 — the author's address is `sha256("addr/1|identity|" + handle)`. §6 — `/address/lamter.eth` and `/about` are the same page: bio, verified social links, deployed contracts, transaction history.

**The content is the author's, not yours.** `content/profile.md` does not exist. Create it containing **only what is already true and checkable**: the handle from `chain.config.ts`, and nothing else. Bio and links ship as **empty** and the page renders nothing where they would go. **Do not invent a bio, a GitHub URL, a Twitter handle, or any other link** — this is a site whose entire premise is that what it displays is verifiable, and a plausible-looking fake link is the worst thing it could carry. The author fills the file in; the page must pick that up with no code change.

**Files:**
- Create: `content/profile.md`, `src/pages/about.astro`
- Modify: `src/site/routes.ts`
- Test: `tests/site/about.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the author address the engine derives', async () => {
  expect(page()).toContain(await identityAddress(CHAIN_CONFIG.authorHandle));
});

it('lists the author\'s transactions', () => {
  // Every post is sent FROM this address, so its history is the whole chain.
  for (const tx of getPosts()) expect(page()).toContain(tx.title!);
});

it('renders no link section when the profile declares none', () => {
  // The failure this guards: shipping placeholder links that go nowhere, on a
  // site whose premise is that what it displays is verifiable.
  expect(page()).not.toMatch(/href="https?:\/\/example\./);
  expect(page()).not.toContain('TODO');
});

it('renders a link only for a profile entry that declares a url', () => { /* fixture-driven */ });
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Create `content/profile.md`** with frontmatter `handle`, `name`, `bio: ""`, `links: []`. Nothing invented.
- [ ] **Step 4: Build `/about`.** Render bio through the same markdown pipeline posts use, so author HTML is dropped and only `http`/`https`/`mailto` survive — a profile is author-controlled but it goes through the same guard as everything else.
- [ ] **Step 5: Flip `about` to `built: true`.**
- [ ] **Step 6: Run the suite, then commit** — `feat(site): add the author address page`

---

### Task 3: `/mempool` — drafts, which are not on the chain

**Spec §3.6 is explicit and must not be blurred:** the mempool and the pending block are different things. *"**Mempool** (`/mempool`) — drafts, not yet published, not in the chain at all. **Pending block** — published posts, in the chain, awaiting the next seal."*

**So a draft has no hash, no address, no gas and no value.** It is a title and a date. Rendering a hash for one — even a computed one — would claim chain membership it does not have. This is the single easiest place on the whole site to ship a falsehood, because the surrounding chrome is all hashes.

**Files:**
- Create: `src/site/drafts.ts`, `src/pages/mempool.astro`, `content/drafts/.gitkeep`
- Modify: `src/site/routes.ts`
- Test: `tests/site/mempool.test.ts`

**Interfaces:**

```ts
export interface Draft { slug: string; title: string; date: string }  // no hash. deliberately.
export function getDrafts(draftsDir?: string): Draft[];               // newest first
```

- [ ] **Step 1: Write the failing tests**

```ts
it('lists drafts newest first', () => { /* fixture-driven */ });

it('renders no hash, address or value for a draft', () => {
  // §3.6: a draft is not in the chain. The page may not imply otherwise.
  const section = mempoolSection();          // scope to the draft list, not the page
  expect(section).not.toMatch(/0x[0-9a-f]{6}/);
  expect(section).not.toMatch(/giờ nghiên cứu/);
});

it('says plainly that drafts are not on the chain', () => {
  expect(page()).toContain('chưa lên chuỗi');
});

it('does not confuse a draft with a pending transaction', () => {
  // A published-but-unsealed post belongs to the OPEN BLOCK and appears on
  // /blocks, not here. If a post file ever appears in both, this must fail.
  const draftSlugs = getDrafts().map((d) => d.slug);
  const chainSlugs = [...getPosts(), ...(getPendingBlock()?.transactions ?? [])].map((t) => t.slug);
  expect(draftSlugs.filter((s) => chainSlugs.includes(s))).toEqual([]);
});

it('renders an empty mempool without pretending otherwise', () => { /* no drafts → explicit empty state */ });
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `src/site/drafts.ts`.** Parse frontmatter with the same parser posts use, but **do not** build a `Transaction` and **do not** hash anything. `content/drafts/` will usually be empty — handle that first, not as an afterthought.
- [ ] **Step 4: Build `/mempool`.** Style it visibly apart from chain records; the em-dash-for-absent-field convention already established for the open block is the right vocabulary.
- [ ] **Step 5: Flip `mempool` to `built: true`.**
- [ ] **Step 6: Run the suite, then commit** — `feat(site): add the mempool of drafts`

---

### Task 4: `/assets` and `/asset/[tokenId]`

**Spec §3.2b:** an asset is a file in `content/assets/` that a post references. Its hash is `sha256` over **raw bytes**, no normalization. Token ID is assigned by first appearance — block height, then transaction order, then asset hash. Real fields only: hash, token ID, mint block, minter, byte size, MIME type, and the posts referencing it. **Explicitly not built:** transfer history, price, rarity, editions, marketplace.

**The chain currently has zero assets.** Both routes must be correct and tested when the registry is empty, and the tests must use fixtures rather than the live registry, or they will pass vacuously forever.

**Carried defect to fix here:** after an image swap two tokens can share a `file`, so `/asset/[tokenId]` must **hash the file on disk** to decide which token the file currently is, rather than trusting the registry's `file` field. A superseded token must say so.

**Files:**
- Create: `src/site/assets-view.ts`, `src/pages/assets.astro`, `src/pages/asset/[tokenId].astro`
- Modify: `src/site/routes.ts`
- Test: `tests/site/assets.test.ts`

**Interfaces:**

```ts
export interface AssetView extends AssetRecord {
  referencedBy: Transaction[];   // every transaction whose `assets` contains this hash
  /** False when the file on disk no longer hashes to this token — a later mint superseded it. */
  current: boolean;
  /** Re-derived from the file on disk; null when the file is missing. Never the recorded value. */
  bytesOnDisk: number | null;
}
export function getAssetViews(assetsDir?: string): AssetView[];       // newest tokenId first
export function getAssetView(tokenId: number, assetsDir?: string): AssetView | undefined;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('marks a token superseded when the file on disk no longer hashes to it', () => {
  // Two tokens can share a `file` after an image swap. Trusting the registry's
  // `file` field would show the NEW image on the OLD token's page and call it
  // verified — the file shown would not be the file the hash commits to.
});

it('lists every transaction that references the token', () => { /* fixture-driven */ });

it('renders both routes with an empty registry', () => {
  // The live chain has zero assets. Without this the routes ship untested.
});

it('shows no price, rarity, edition or transfer history', () => {
  // §3.2b rules these out by name: they have no referent on a personal blog.
  for (const word of ['price', 'rarity', 'edition', 'transfer']) {
    expect(page().toLowerCase()).not.toContain(word);
  }
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `src/site/assets-view.ts`,** hashing each file's raw bytes to determine `current`. Missing file → `bytesOnDisk: null` and an em dash, never the recorded number.
- [ ] **Step 4: Build both routes.** The detail page shows the full hash (detail-page rule) and embeds the file itself for an image MIME type.
- [ ] **Step 5: Flip `assets` to `built: true`.**
- [ ] **Step 6: Run the suite and the link-integrity test, then commit** — `feat(site): add the asset gallery and token pages`

---

## Self-Review

**Spec coverage.** §3.7 addresses → Tasks 1, 2. §3.8 value received → Task 1. §3.2b assets → Task 4. §3.6 mempool-vs-pending distinction → Task 3. §6 page table → all four. `/contracts`, RSS, `/verify` and `/chain.json` are explicitly out of scope above, not omissions.

**Placeholder scan.** Two tasks intentionally ship *empty content* rather than placeholder content: `content/profile.md` (Task 2) and `content/drafts/` (Task 3). That is the point — inventing a bio or a fake draft would put unverifiable claims on the site. No task contains a "TBD" step.

**Type consistency.** `AddressView`, `Draft`, `AssetView` are defined in Tasks 1, 3, 4 and used under those exact names. `getPendingBlock()` takes no arguments and is synchronous. `AssetView extends AssetRecord`, whose fields are fixed in `src/chain/types.ts` and must not change here.

**Risk flagged for every implementer.** Every serious defect on the previous plan was found by driving the real workflow end to end in a sandbox copy, and none by the test suite, which was green at each step. Add a draft, add an asset, reference it from a post, swap the image, delete the file — then look at the built pages.
