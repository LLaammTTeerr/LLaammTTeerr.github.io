# Feed, Raw Ledger and Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the routes §6 names — a feed readers can subscribe to, the raw ledger a browser can verify against, and the author's projects as contracts — leaving only the interactive verifier for Plan 3.

**Architecture:** All three are derived views over content that already exists. `/chain.json` is the committed ledger served verbatim, which is what makes it checkable. `/rss.xml` is built from the same resolved-post data the site renders. Contracts are a new content type that, like the profile, is **off the chain** and must say so (§5.1).

**Tech Stack:** Astro 7 static output, TypeScript, Vitest. No new dependencies — Astro emits non-HTML routes from a `.ts` file under `src/pages/`.

## Global Constraints

- **No module under `src/site/` may read the clock.** `now` is always an injected `YYYY-MM-DD`. A golden-file snapshot guards determinism, and two consecutive builds must be byte-identical.
- **`verifyChain` must never throw** on untrusted input.
- **`verify.ts` and its transitive closure** (`canonical.ts`, `hash.ts`, `merkle.ts`, `types.ts`) must never reach a Node built-in or a bare package specifier — it runs in the browser.
- **Sealed blocks are frozen**; `chain.lock.json` is never rewritten for an existing block.
- **No hard-coded colours** — eleven reader-selectable palettes; a test scans the whole stylesheet.
- **Explorer chrome is English; author-facing content is Vietnamese.**
- **Every displayed field must be committed, or re-derived from something committed.** Otherwise omit it with an em dash.
- **§5.1: anything not on the chain must say so where it is displayed.**
- **Zero dead links and every `src` resolves.** `src/site/routes.ts` holds one `built` flag per route; flip each as it lands.
- **A post row's identity depends on the page's question.** A *ledger* view (`/blocks`, `/tx`) shows each transaction as recorded, with its own hash. A view answering "what is this post now" (`/address/[name]`, `/about`, `/tx/[slug]`) resolves to the governing record and takes a `ResolvedPost`. Choose deliberately and say which you chose.
- `noUncheckedIndexedAccess: true`; `npm run typecheck` runs `tsc --noEmit && astro check`.
- `npm test` — 757 currently passing, and the suite must stay green **both** with the demo corpus seeded and with it cleared.

## Known blocker, to surface not to guess

`site` in `astro.config.mjs` is the placeholder `https://lamter.example`. **RSS requires absolute URLs**, so the feed is only correct once that is the real domain. Build the feed from Astro's `site` so it becomes correct the moment the value is, add a test asserting every URL in the feed is absolute and derived from `site`, and **do not invent a domain**. Task 2 reports this rather than resolving it.

## File Structure

| File | Responsibility |
|---|---|
| `src/pages/chain.json.ts` (create) | The sealed ledger, served verbatim |
| `src/pages/rss.xml.ts` (create) | Feed of posts, absolute URLs from `site` |
| `src/site/contracts.ts` (create) | Read `content/contracts/`; off-chain, like drafts |
| `src/pages/contracts.astro`, `src/pages/contract/[name].astro` (create) | List and detail |
| `scripts/demo-content.ts` (modify) | Demo contracts, so the pages are previewable |
| `src/site/routes.ts` (modify) | Flip `contracts` |

---

### Task 1: `/chain.json` — the raw ledger

**Why first:** §7 says *"`/verify` fetches `chain.json` and recomputes the chain in the reader's browser."* Plan 3's verifier is built on this, and it is the smallest of the three.

**The property that matters:** what `/chain.json` serves must be **byte-identical to `chain.lock.json`**. A reader who fetches it and diffs it against the committed file must get nothing. Serialise nothing yourself — read the committed bytes and serve them. Re-serialising through `JSON.stringify` would produce a file that is *equivalent* but not *identical*, and equality is the whole point of publishing it.

**Files:**
- Create: `src/pages/chain.json.ts`
- Test: `tests/site/chain-json.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('serves bytes identical to the committed ledger', () => {
  expect(readDist('chain.json')).toBe(readFileSync('chain.lock.json', 'utf8'));
});

it('verifies as a chain, fetched exactly as a browser would get it', async () => {
  // The point of publishing it. If this ever fails, the file a reader checks
  // is not the file the site was built from.
  const result = await verifyChain(JSON.parse(readDist('chain.json')));
  expect(result.ok).toBe(true);
});

it('serves the open block separately, or not at all — never merged in', () => {
  // A pending transaction has a real hash but no mined block. Merging the open
  // block into the ledger would produce a document `verifyChain` must reject,
  // and a reader would reasonably conclude the chain was broken.
  const parsed = JSON.parse(readDist('chain.json')) as { blocks: { nonce: number }[] };
  expect(parsed.blocks.every((b) => Number.isInteger(b.nonce))).toBe(true);
});
```

- [ ] **Step 2: Run and confirm each fails for its own reason.**
- [ ] **Step 3: Implement.** An Astro endpoint returning the file's bytes with `content-type: application/json`. Decide whether the open block gets its own route (`/chain.pending.json`) and say why in your report — the verifier will eventually want it, but it cannot be part of the ledger document.
- [ ] **Step 4: Run the suite seeded and cleared, then commit** — `feat(site): publish the raw ledger at /chain.json`

---

### Task 2: `/rss.xml` — the feed

**Files:**
- Create: `src/pages/rss.xml.ts`
- Test: `tests/site/rss.test.ts`

**What goes in it:** every post, newest first — including the open block's, which have real hashes and real pages. Titles and dates come from the **governing record**, so an amended post's feed entry shows its current title: a feed is answering "what is this post", not "what did this transaction record".

`summary` is parsed from frontmatter and **hashed nowhere**. It may be used as the item description — a feed description is not chain-attested and nothing on the page claims otherwise — but do not put it anywhere a reader would read it as committed.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists every post, newest first', () => { /* derived from the chain, not hard-coded */ });

it('uses absolute urls built from the configured site', () => {
  // Relative urls in a feed resolve against the reader's feed reader, not the
  // site. Every link must be absolute, and must come from `site` so it is
  // correct the moment that value is.
  for (const link of linksIn(readDist('rss.xml'))) {
    expect(link.startsWith('https://')).toBe(true);
    expect(link.startsWith(SITE)).toBe(true);
  }
});

it('shows an amended post under its current title', () => {
  // Needs a chain containing an amendment — `npm run demo:seed` has one, or
  // build a fixture. A chain without one cannot tell the two answers apart.
});

it('is well-formed xml', () => { /* parse it, do not regex it */ });

it('escapes a title containing xml syntax', () => {
  // A title with & or < must not produce a broken document. Assert against a
  // fixture title carrying both, not against whatever the corpus happens to
  // contain today.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Report the `site` placeholder explicitly** in your report — what the feed currently emits, and what the author must change before publishing.
- [ ] **Step 5: Run the suite seeded and cleared, then commit** — `feat(site): add the rss feed`

---

### Task 3: `/contracts` and `/contract/[name]`

**Spec §6:** *"Projects as verified contracts, source linked to GitHub."* §4: *"Smart contract — one of the author's projects; 'verified source' links to GitHub."*

**§5.1 governs this page.** `content/contracts/` is read at build time and hashed nowhere. So a contract page must say its content is off the chain, using the vocabulary the site already has — `chưa lên chuỗi`, as `/about` and `/mempool` do. Read how `/about` marks its off-chain half and follow it rather than inventing a third treatment.

**"Verified" is a word this project cannot use loosely.** Everywhere else on the site it means "recomputable from a committed hash". A contract's source is a GitHub link, which is not that. Do not label a contract "verified" unless something actually verifies it; if the design wants that word, say what would have to be true and report it rather than shipping the claim.

**Files:**
- Create: `src/site/contracts.ts`, `src/pages/contracts.astro`, `src/pages/contract/[name].astro`, `content/contracts/.gitkeep`
- Modify: `scripts/demo-content.ts` (demo contracts), `src/site/routes.ts`
- Test: `tests/site/contracts.test.ts`

**Interfaces:**

```ts
export interface Contract {
  slug: string;      // route param
  name: string;      // display name
  summary: string;
  repo: string | null;   // https url, or null — never a placeholder
  language: string | null;
  body: string;      // markdown, rendered through the site's pipeline
}
export function getContracts(dir?: string): Contract[];
```

- [ ] **Step 1: Write the failing tests** — the list renders with `content/contracts/` empty (the state it ships in); a contract's page renders its body through the markdown pipeline so author HTML is dropped and only safe URL schemes survive; the off-chain marker is present and sits with the contract content rather than anywhere on the page; a contract with no `repo` renders no link rather than a dead one.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement,** reusing the mempool's off-chain card treatment.
- [ ] **Step 4: Add two demo contracts** to `scripts/demo-content.ts`, removed by `demo:clear` like everything else there. Use obviously placeholder repo URLs, as the profile does.
- [ ] **Step 5: Flip `contracts` to `built: true`.** Every nav entry then links except `Verify`.
- [ ] **Step 6: Run the suite seeded and cleared, verify zero dead links, then commit** — `feat(site): add the contracts pages`

---

## Self-Review

**Spec coverage.** §6's `/chain.json` → Task 1, `/rss.xml` → Task 2, `/contracts` and `/contract/[name]` → Task 3. §7's verifier dependency on `chain.json` → Task 1. §5.1 off-chain rule → Task 3. After this plan, `/verify` is the only route in §6 not built, and it is Plan 3's.

**Type consistency.** `Contract` is defined in Task 3 and used only there. Tasks 1 and 2 add no new exported types. `getContracts` mirrors `getDrafts`'s shape, deliberately — both read off-chain content.

**Risk flagged for every implementer.** Every serious defect on this project was found by driving the real workflow end to end, and none by the suite passing. Before calling a task done: seed the demo, build, and look at the actual output — including, for the feed, in a reader rather than only in a test.

**Known gap this plan does not close.** `site` and `base` in `astro.config.mjs` are placeholders. Task 2 makes the feed correct-by-construction once they are set and reports the fact; it does not guess a domain.
