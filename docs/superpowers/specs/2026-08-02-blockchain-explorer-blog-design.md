# Chain Blog — Design Spec

**Date:** 2026-08-02
**Status:** Approved for planning
**Author:** lamter (with Claude)

---

## 1. Summary

A personal blog rendered as a blockchain explorer. Posts are transactions, grouped
into cryptographically chained blocks, with metadata that is genuine rather than
decorative: real SHA-256 hashes, real Merkle roots, and a real proof-of-work
nonce mined at build time. Every displayed field is committed to the chain, so a
reader can verify it.

The site builds to pure static files and requires no server. Readers can
independently verify the entire chain in their own browser.

### Goals

- Publish long-form Vietnamese writing on competitive programming, software
  projects, personal essays, and blockchain topics.
- Present that writing through a blockchain-explorer interface where every piece
  of displayed metadata is real and independently verifiable.
- Stay entirely static: hostable on GitHub Pages, Cloudflare Pages, or any static
  host, with no backend and no database.
- Publish by writing a Markdown file and pushing to git.

### Non-goals (v1)

Comments, analytics, newsletter/subscribe, English or bilingual content, and any
crypto metaphor beyond those specified in §4. Six real metadata fields beat twenty
invented ones; unchecked metaphor expansion is the main way this design fails.

---

## 2. Core problem and its solution

Real chains are immutable. Blogs get typo fixes. If hashes were recomputed from
scratch on every build, editing one old post would silently rewrite every block
after it, and the chain would be a fiction that changes on each deploy.

**Solution: a committed `chain.lock.json` ledger.**

- Once a block is sealed, its hashes and nonce are frozen in the lock file and are
  never recomputed.
- Each build mines at most one new block. Builds are therefore fast and idempotent.
- Editing an already-sealed post does not rewrite history. The build detects the
  content-hash mismatch and emits an **amendment transaction** in the current
  block, referencing the original transaction hash — mirroring how real chains
  handle state change: history is immutable, corrections are new transactions.

This property is what makes the concept honest rather than theatrical, and every
other decision in this spec is subordinate to it.

---

## 3. Chain specification

All format strings carry a version prefix (`tx/1`, `block/1`, `addr/1`) so the
format can evolve later without ambiguity about how an old hash was derived.

### 3.1 Content normalization

Before hashing, a post body is normalized:

1. Line endings converted to `LF`.
2. Trailing whitespace stripped from each line.
3. Exactly one trailing newline.

Normalization is applied to the raw Markdown source, not to rendered HTML.
Rendering is a presentation concern and must never affect a hash.

### 3.2 Transaction hash

Canonical serialization of a transaction, joined with `\n`:

```
tx/1
title:<title>
date:<YYYY-MM-DD>
tags:<comma-joined, sorted, lowercased slugs>
series:<slug, or empty string>
research:<hours, always exactly one decimal place>
from:<author address>
body:<hex sha256 of the normalized body>
```

`txHash = sha256(canonical)`, rendered as `0x` + 64 lowercase hex characters.
Displayed truncated with a middle ellipsis and a click-to-copy affordance.

`research` is the one field not derivable from the body (§3.8), which is exactly
why it is committed to the hash: an author-declared number displayed beside
verified data would otherwise be unverifiable decoration. Including it makes the
declaration tamper-evident — revising a past claim produces a visible amendment
rather than a silent edit.

Its serialization is fixed at one decimal place (`12.5`, `0.0`, `40.0`) so that
`12.5`, `12.50`, and `12.500` in frontmatter cannot produce three different
hashes for identical content.

### 3.3 Merkle root

Standard binary Merkle tree over the block's transaction hashes in block order:

- Leaves are the raw 32-byte digests, not their hex strings.
- Each internal node is `sha256(left || right)` over concatenated bytes.
- If a level has an odd number of nodes, the last node is duplicated
  (the Bitcoin rule).
- The root of an empty set is 32 zero bytes.

### 3.4 Block header and mining

Canonical serialization of a block header, joined with `\n`:

```
block/1
height:<n>
prevHash:<hex>
merkleRoot:<hex>
timestamp:<ISO 8601 UTC>
txCount:<n>
gasUsed:<n>
difficulty:<n>
nonce:<n>
```

`blockHash = sha256(header)`. Mining increments `nonce` from 0 until `blockHash`
begins with `difficulty` hexadecimal zeros.

`timestamp` is **never the wall-clock build time**, at `00:00:00Z`:

- Block with transactions: `max(latest transaction date, previous timestamp)`.
- Empty block (§3.6): `max(last day of the block's calendar month, previous
  timestamp)`.

Using the actual sealing time would make every build produce a different hash and
would directly contradict the determinism requirement in §11 and §14.

The previous block's timestamp participates in the maximum to keep timestamps
monotonically non-decreasing along the chain, as real chains require. Without it,
a block containing only amendments — which carry the date of the older post they
amend (§3.9) — could be timestamped earlier than its own parent.

**Difficulty: 5** (~1M hashes, roughly one second in Node). Configurable. Paid
exactly once per block over the lifetime of the site, because sealed blocks are
frozen in the lock file.

### 3.5 Genesis

Block `#0`, with `prevHash` set to 64 zeros. Sealed like any other block.

### 3.6 Sealing rule

A block seals when it reaches **4 transactions** or when the **calendar month
ends**, whichever comes first. This mirrors a real block size limit paired with a
block time target. Both values are configurable, and changing them later is safe:
sealed blocks are frozen in the lock file, so a change affects only the pending
block and everything after it.

**Empty blocks are minted.** A month with no posts still produces a sealed block
with zero transactions, a Merkle root of 32 zero bytes (§3.3), `gasUsed: 0`, and
`value: 0`. It is mined like any other block. This matches real chains, and it
makes the chain an honest record: a gap in writing becomes a visible run of empty
blocks rather than silently vanishing from history.

Empty-block minting is the one place the build consults the current date, to know
which months have elapsed. Blocks are minted for every complete calendar month
between the last sealed block and the current month; the current month is never
sealed, since it is still open. The clock is therefore an **explicit injected
input to the build**, not an ambient call, so tests can pin it (§11).

Transactions not yet in a sealed block belong to the **pending block**, which is
displayed with its transaction list but without a hash or nonce, since neither
exists until sealing.

**Block membership is when a transaction entered the chain, not the date it
claims.** A transaction dated earlier than the first still-open month — an
amendment, which carries the date of the post it amends (§3.9), or a
deliberately backdated post — is placed in that open month. It keeps its
original `date` as a visible field; only its block placement moves forward.

Without this rule, editing an old post would reopen months already sealed and
mint empty blocks for months that were not silent. Real chains behave the same
way: a transaction joins the block that mines it, whatever it refers to.
Block periods are therefore non-decreasing along the chain, though two blocks
may share a period when the size limit splits a busy month.

The pending block and the mempool are distinct and must not be conflated:

- **Mempool** (`/mempool`) — drafts, not yet published, not in the chain at all.
- **Pending block** — published posts, in the chain, awaiting the next seal.

### 3.7 Addresses

An address is `0x` + the first 40 hex characters of:

```
sha256("addr/1|tag|" + slug)          for a tag or series
sha256("addr/1|identity|" + handle)   for the author
```

Raw hex is unreadable, so — as ENS names work on a real explorer — every address
also resolves to a name:

```
0x7f3a91c4…e02b   →   cp.tag
0x1d84be07…9a33   →   blockchain.tag
0xc402f18a…7de1   →   lamter.eth
```

A post sends to every tag it carries, so multi-tag posts create no conflict.

### 3.8 Gas and value

- `gasUsed` — word count of the normalized body, derived. A block's `gasUsed` is
  the sum over its transactions.
- `value` — **hours of research the author declares**, from the optional
  `research` frontmatter field. Displayed as `12.5 hrs research`. A block's
  `value` is the sum over its transactions; an address page shows total value
  received, which is a genuine measure of effort spent on that topic.

`research` is optional and defaults to `0.0`, which displays as `—` rather than a
misleading `0`, so a short note can be published without ceremony. Adding the
value later is a legitimate edit and correctly produces an amendment (§3.9).

Reading time is computed for display on post pages and listings but is not a
chain field — it is a straightforward function of `gasUsed` and would be
redundant in the ledger.

These are the only two value-bearing fields. Nothing further is invented.

### 3.9 Amendments

On each build, for every transaction in a sealed block, the content hash is
recomputed and compared against the recorded value. On mismatch the build:

1. Emits an amendment transaction into the pending block, carrying
   `type: "amendment"`, `amends: <original txHash>`, and the new content hash.
2. Prints a build-log notice. This is a notice, not an error — amending is a
   supported, expected operation.

The original post page then displays "Amended in block #N", linking to the
amendment. The amendment is placed in the pending block regardless of the date
it carries, per the membership rule in §3.6.

An amendment is a transaction and so needs its own canonical form, distinct from
`tx/1` in §3.2:

```
tx/1
type:amendment
date:<YYYY-MM-DD of the amended post>
amends:<original txHash>
from:<author address>
body:<hex sha256 of the new normalized body>
```

An amendment carries `gasUsed: 0` and `value: 0`; the word count already belongs
to the transaction it amends, and counting it twice would inflate chain totals.
Amendments are listed in block transaction tables but excluded from post lists,
RSS, and the search index — they are ledger entries, not new writing.

---

## 4. Concept mapping

| Blockchain | Blog |
|---|---|
| Transaction | A post |
| Transaction hash | SHA-256 over the post's canonical form |
| Block | A sealed batch of posts (§3.6) |
| Nonce | Real proof-of-work, mined at build time |
| Merkle root | Real Merkle tree over the block's transaction hashes |
| Previous hash | Genuine chain link — tamper-evident history |
| Address `0x…` | A tag or series; posts send to it |
| Smart contract | One of the author's projects; "verified source" links to GitHub |
| Author's address page | The about-me page |
| Mempool | Drafts and works in progress |
| Gas used | Word count |
| Value | Reading time in minutes |
| Genesis block | The first post |
| Network stats | Homepage dashboard |

---

## 5. Content model

```
content/
  posts/2026-07-28-mo-algorithm.md     published transactions
  drafts/wip-segment-tree.md           mempool
  contracts/cf-mcp.md                  projects
  profile.md                           author address page
```

Post frontmatter, validated by an Astro Content Collections schema:

```yaml
title: "Mo's Algorithm và cách tối ưu"
date: 2026-07-28
tags: [cp, algorithm]
series: "Ghi chú thuật toán"   # optional
research: 12.5                 # optional, hours; defaults to 0.0
summary: "Tóm tắt ngắn cho trang danh sách."
```

A malformed post fails the build with a specific message rather than shipping
broken. Transaction order within a block is by `date`, ties broken by filename, so
ordering is deterministic and independent of filesystem enumeration order.
Amendments sort after all ordinary transactions in their block, ordered by the
`amends` hash — they carry an old date (§3.9) and would otherwise sort into the
middle of unrelated posts.

---

## 6. Pages

| Route | Purpose |
|---|---|
| `/` | Network dashboard: chain height, total transactions, address count, average block time, latest blocks and latest transactions panels, search, activity sparkline |
| `/blocks` | Paginated block list |
| `/block/[height]` | Block detail: header fields plus its transaction list |
| `/tx/[slug]` | **A post.** Canonical URL — explorer-flavoured path, still readable and SEO-friendly |
| `/address/[name]` | Tag or series page: transaction list, post count, first seen, last seen |
| `/address/lamter.eth`, `/about` | Author profile: bio, verified social links, deployed contracts, transaction history |
| `/contracts`, `/contract/[name]` | Projects as verified contracts, source linked to GitHub |
| `/mempool` | Drafts and WIP as pending transactions |
| `/verify` | Chain verifier |
| `/chain.json` | The raw ledger |
| `/rss.xml` | RSS feed |
| `404` | "Transaction not found — invalid hash or unmined" |

Pasting a full `0x…` transaction hash into the search box resolves to its post.

### 6.1 Post page layout

A compact transaction-detail panel (hash, block, timestamp, from, to, gas used,
confirmation status), followed by the article body in proper long-form typography
at a 65–75 character measure.

This split is deliberate. An explorer interface is optimized for scanning dense
tables and is hostile to reading two thousand words; the theme owns the chrome,
and readability owns the body. Code blocks and LaTeX render normally.

---

## 7. Verification

`/verify` fetches `chain.json` and recomputes the chain in the reader's browser
via Web Crypto, streaming results per block: block hash from header, Merkle root
from transaction hashes, previous-hash linkage, and proof-of-work difficulty.

Each post page additionally offers **"Verify this transaction"**, which fetches
that post's canonical source and hashes it live — closing the loop from raw text
through to block hash.

**Key architectural constraint:** verification logic lives in one pure module used
by both the build and the browser. The same code proves the chain in Node and in
the reader's tab, so the two cannot drift.

---

## 8. Architecture

```
src/chain/
  canonical.ts   post → canonical byte string (§3.2)
  hash.ts        sha256, isomorphic (node:crypto | crypto.subtle)
  merkle.ts      root and proofs (§3.3)
  mine.ts        proof-of-work nonce search (§3.4)
  seal.ts        block sealing rules, incl. empty-block minting (§3.6);
                 takes the clock as an explicit parameter, never reads it
  address.ts     tag/author → address and name (§3.7)
  verify.ts      pure verification — used by build AND browser (§7)
  lock.ts        read and write chain.lock.json (§2)
```

Every module is independently testable, depends only on `hash.ts` and its own
inputs, and has one clear purpose. `verify.ts` depending on nothing but `hash.ts`
and `merkle.ts` is precisely what allows the browser to reuse it unchanged.

**Framework: Astro.** Content Collections provide schema-validated frontmatter,
zero JavaScript ships by default, and islands cover the only two interactive
surfaces — search and the verifier. KaTeX and syntax highlighting are built in,
which is non-negotiable given the competitive-programming content.

**Search:** a build-time JSON index, lazy-loaded on first focus of the search
box. No server and no heavy dependency; the corpus is tens to hundreds of posts.

---

## 9. Visual direction

Dark-first on a near-black canvas. Monospace for every hash and metadata field,
middle-truncated with click-to-copy. A humanist sans for Vietnamese prose. Status
pills (`✓ Confirmed`, `⏳ Pending`). The accent is deliberately not Etherscan
blue: an amber "mined" accent, with green reserved for confirmations.

Fonts are self-hosted — no external CDN — which keeps the build portable and
avoids a third-party request on every page load.

---

## 10. Error handling

| Condition | Behaviour |
|---|---|
| Malformed post frontmatter | Build fails with the file path and the failing field |
| Edited sealed post | Amendment transaction emitted, build-log notice (§3.9) |
| `chain.lock.json` inconsistent with itself | Build fails; the lock is the source of truth and must never be silently repaired |
| Missing lock file | Treated as a fresh chain; Genesis is mined |
| Unknown route or unresolvable hash | 404 page in explorer vocabulary |
| Verifier finds a mismatch in-browser | Failure surfaced explicitly per block, never swallowed |

---

## 11. Testing

Vitest unit tests over each chain module: canonical serialization, the SHA-256
helper across both runtimes, Merkle root construction including the odd-count
duplication rule, the miner, sealing rules, address derivation, and amendment
detection.

**Golden-file test:** a fixed set of fixture posts, built against a **pinned
clock**, must produce a byte-identical `chain.lock.json`. This test guards
determinism, which is the property the entire concept rests on. If it ever fails,
the chain is untrustworthy.

Empty-block minting gets its own tests, driven by advancing the injected clock
over a fixture chain: skipping several months mints one block per elapsed month,
the current month is never sealed, and re-running at the same clock is a no-op.

Verification is additionally asserted end-to-end: build a fixture chain, then run
`verify.ts` against it and require a clean result.

---

## 12. Hosting and publishing

GitHub Actions builds and deploys to GitHub Pages on push to `main`. Output is
plain static files, so migrating to Cloudflare Pages later is roughly a
ten-minute change.

Publishing workflow: write a Markdown file, commit, push. Browser-based writing
is available through GitHub's built-in web editor (press `.` on the repository),
so no CMS layer is needed to write from another machine.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Non-deterministic rebuilds destroy chain credibility | Lock file plus the golden-file test (§11) |
| Explorer density harms readability | Split post page: explorer chrome, article body (§6.1) |
| Vietnamese diacritics render poorly in monospace | Verify full Vietnamese coverage before committing to a font pairing; self-host |
| Metaphor creep produces meaningless metadata | Fields fixed at §3.8; anything further is out of scope |
| A near-empty site looks barren in an explorer UI | Genesis block plus seed content; empty states designed, not defaulted |

---

## 14. Success criteria

- `npm run build` produces static output, byte-identical across repeated runs at
  a fixed clock. The only permitted difference between builds run at different
  times is newly minted empty blocks (§3.6); no existing block may ever change.
- The chain verifies clean in-browser at `/verify`.
- Publishing is write-a-file-and-push, live in under three minutes.
- Lighthouse performance and accessibility both ≥ 95.
- Post body sits at a 65–75 character measure with body text ≥ 18px.
- Every metadata field displayed anywhere on the site is either derived from
  content or declared in frontmatter, and in both cases is committed to the chain
  and independently verifiable.
