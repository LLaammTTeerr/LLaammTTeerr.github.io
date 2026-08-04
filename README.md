# Blogchain

A personal blog rendered as a blockchain explorer — where the blockchain is real.

**[llaammtteerr.github.io](https://llaammtteerr.github.io)**

Posts are transactions. Calendar months are blocks. Tags are addresses. Uploaded diagrams are
minted tokens. None of it is decorative: the hashes are SHA-256 over a canonical serialization,
the Merkle roots are real Merkle trees, and the nonces are mined at build time against a
difficulty target.

Content is in Vietnamese; the explorer chrome is in English.

## Don't trust it — check it

The point of building this on a real chain is that you don't have to take the site's word for
anything. Two standard commands, no JavaScript:

```sh
SITE=https://llaammtteerr.github.io
SLUG=2026-07-26-hash-functions          # any slug from /tx

# what the post actually says
BODY=$(curl -s "$SITE/tx/$SLUG/body.txt" | sha256sum | cut -d" " -f1)

# what the chain committed to — the newest record governing that post,
# which is its latest amendment if it has been edited, else the post itself
CHAIN=$(curl -s "$SITE/chain.json" | python3 -c "
import json, sys
txs = [t for b in json.load(sys.stdin)['blocks'] for t in b['transactions']]
post = next(t for t in txs if t.get('slug') == '$SLUG')
amendments = [t for t in txs if t.get('amends') == post['hash']]
print((amendments[-1] if amendments else post)['contentHash'])")

[ "0x$BODY" = "$CHAIN" ] && echo "MATCH" || echo "MISMATCH"
```

They match, or the site is lying. Change `SLUG` to any post you like — the expected hash is
whatever that post's own record says, so there is nothing to memorise and nothing to compare by
eye.

The amendment step is not incidental. Editing a published post never rewrites its sealed
transaction: it appends an **amendment** that commits to the new text, and the original stays on
the chain exactly as it was. So the hash to check a post against is the newest record that governs
it, and a checker that stops at the post's own transaction will report a mismatch on every post
that has ever been edited — while the site is behaving correctly.

Nothing in that check runs code this repository wrote: `/chain.json` is served byte-for-byte
identical to the `chain.lock.json` committed here, and `body.txt` is the exact text the hash is
over.

For the whole chain at once, [`/verify`](https://llaammtteerr.github.io/verify) recomputes every
block in your browser via Web Crypto — block hashes from headers, Merkle roots from transaction
hashes, **each transaction's hash recomputed from its fields**, gas and value sums, previous-hash
linkage, and proof-of-work. That last-but-one point matters: checking only the Merkle root proves
the recorded hashes agree with each other, not that they match the title displayed beside them. A
forged title would verify clean.

Where something *can't* be verified, the site says so rather than staying quiet — a block's
`period`, an asset's filename, and anything on the pages marked `chưa lên chuỗi` (not on the
chain): drafts, the profile, and the project descriptions.

## How the chain works

| Blockchain | Blog |
|---|---|
| Transaction | A post |
| Block | A calendar month, sealed at 4 posts or month-end, whichever comes first |
| Nonce | Real proof-of-work, mined at build time (difficulty 5) |
| Merkle root | A real Merkle tree over the block's transaction hashes |
| Address | A tag or series that posts send to |
| Gas used | Word count |
| Value | Hours of research the author declares |
| Mempool | Drafts — deliberately *not* on the chain |
| Smart contract | One of the author's projects |

A silent month still mines an empty block, so the chain has no gaps. Editing a published post
produces a visible **amendment** rather than a silent rewrite, because sealed blocks are frozen.

`chain.lock.json` is the sealed ledger and is committed. `chain.pending.json` records the **open
block** — this month's posts, with their real hashes, before they seal — so a post published today
has a page and a URL immediately, marked as unsealed.

## Running it

Requires Node ≥ 22.12.

```sh
npm install
npm run dev        # http://localhost:4321
```

| Command | |
|---|---|
| `npm run chain:build` | Hash new posts, mine any blocks that are due, record the open block |
| `npm run chain:verify` | Verify the committed ledger |
| `npm run build` | Build the static site into `dist/` |
| `npm test` | The suite |
| `npm run typecheck` | `tsc` plus `astro check` — the second is what checks `.astro` files |

### Writing a post

Add a markdown file to `content/posts/`, then run `npm run chain:build`. Frontmatter:

```yaml
title: "Mo's Algorithm và cách tối ưu"
date: 2026-07-28
tags: [cp, algorithm]
series: "Ghi chú thuật toán"   # optional
research: 12.5                 # optional, hours; omitted renders as —
```

**Edit a published post and `npm run build` will fail**, naming the file and both hashes, until
you run `chain:build` to record the amendment. That is deliberate: the site refuses to render text
its own verify button would contradict. CI never runs `chain:build`, so the failure mode in
production is *the site stops updating* — if a push seems to do nothing, check the Actions tab.

### Demo content

```sh
npm run demo:seed     # 14 posts over 6 months: a split month, a silent month,
                      # an amendment, a series, 2 tokens, 3 drafts
npm run demo:clear    # removes exactly those, rebuilds the chain
```

The test suite passes with the demo corpus present *and* absent, so neither is the special case.

## Layout

```
src/chain/     the engine — hashing, Merkle, mining, sealing, amendments, verification
src/site/      the only code that reads the ledger
src/pages/     routes
content/       posts, drafts, assets, contracts, profile
scripts/       chain build, verification, demo corpus
docs/superpowers/   the design spec, the implementation plans, and a decision log
```

`src/chain/verify.ts` and everything it imports are free of Node built-ins, enforced by a test
that walks the import graph — that is what lets the same verification code run in the build and in
a reader's browser, so the two cannot prove different things.

## Deployment

GitHub Actions builds on every push and publishes `main` to GitHub Pages. The workflow runs the
same checks a developer runs, plus an explicit ledger verification, and deliberately never mines.

---

Built with [Astro](https://astro.build). The design spec is in
[`docs/superpowers/specs/`](docs/superpowers/specs/) if you want to know why something is the way
it is.
