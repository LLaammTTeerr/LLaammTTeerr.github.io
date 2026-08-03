# Decisions taken while you were away — 2026-08-03

You gave me authority to decide everything until 8am and to record ambiguities rather than ask.
Every judgement call is below with its reasoning, newest last. Anything you disagree with is
cheap to reverse; I have noted how for each.

---

## D1 — `.astro` files are not type-checked at all

**Found:** Task 5's implementer reported that making `TxPanel`'s `pending` prop required is not
enforced by anything that runs here. `tsc --noEmit` does not read `.astro` files, and
`@astrojs/check` is not installed. So every prop type, every `Props` interface, and every bit of
frontmatter logic in the eleven `.astro` files is unchecked.

**Why it matters:** I made that prop required specifically so the type checker would make
"forget to pass `pending` and render `Sealed` on an unconfirmed transaction" impossible. It
turns out nothing checks it. The guarantee I thought I was buying does not exist.

**Decision:** install `@astrojs/check` and add it to `npm run typecheck`.

**Reasoning:** several correctness properties on this branch live in `.astro` frontmatter — the
derived stamp, the open-block lookup, `getStaticPaths` filtering amendments out of post routes.
Leaving them unchecked while believing they are checked is worse than knowing they are not.

**To reverse:** remove the dependency and the script change.

---

## D2 — the open block gets no `/block/<height>` page

**Ambiguity:** the pending panel's `Block` field links somewhere. `/block/<height>` is Task 6's
route for sealed blocks. Does the open block get one too? It does have a height (tip + 1), but
it has no hash, no nonce, no merkle root, and its height is a prediction rather than a fact —
if a size-split seals first, the number changes.

**Decision:** `/block/<height>` is for sealed blocks only. The open block is reachable at
`/blocks`, where it renders at the top of the list, and the pending panel links to `/blocks`.

**Reasoning:** a URL that names a height the chain has not committed to would be the same class
of falsehood as a hash it has not mined. `/blocks` always exists and always shows it.

**To reverse:** add a `/block/open` route in a later plan; the link target is one line.

---

## D3 — three tests would have broken the first time you published

**Found:** `pending-render.test.ts` and `build-guarantees.test.ts` asserted the sandbox showed
`pending 1 txn` — an exact count. The sandbox copies the real repo's `chain.pending.json`, so
the first time you publish a post in the current month and commit that file, the test's own
fixture becomes the *second* pending transaction and the assertion fails.

**Decision:** fixed rather than deferred. Added `pendingIdsIn(dir)` to the test harness; each
test now asserts *its own* transaction is pending instead of counting the block.

**Reasoning:** it would have failed on your first real use of the feature this plan was built
for, and it would have looked like the feature was broken rather than the test. Proved both
ways before and after — with a pending transaction present, the old assertion threw and the
new one passes.

**To reverse:** nothing to reverse; this only removes a false failure.

---

## D4 — Task 5's implementer edited three files outside its brief

**Found:** it fixed two count assertions in `homepage.test.ts` and an em-dash fixture in
`build-guarantees.test.ts` — files its task did not own — because its own change would
otherwise have broken them.

**Decision:** accepted, and flagged for the whole-branch review to verify rather than reverting
now.

**Reasoning:** the alternative was leaving the branch red. The edits are small and in the same
failure class as D3. I would rather a reviewer confirm them with fresh eyes than have me wave
them through on the implementer's description.

---

## D5 — the homepage and `/blocks` render the identical list

**Found:** the homepage already listed every block, so building `/blocks` produced two routes
with the same content. It also means the homepage grows without bound as the chain does.

**Decision:** the homepage shows the **latest 5 blocks** plus a link to `/blocks`; `/blocks`
keeps the complete list.

**Reasoning:** this is what every block explorer does, and it is the only version where the two
routes have distinct jobs. The alternative — deleting `/blocks` — loses the ability to browse
the whole chain, which is worse as the chain grows.

**To reverse:** change one slice in `index.astro`. Note it does change several
`homepage.test.ts` assertions, so a revert means revisiting those too.

**Ambiguity for you:** 5 is my pick, not a derived number. Say a word if you want more or fewer.

---

## D6 — five nav links 404 on every page

**Found:** the header links `/tx`, `/address`, `/assets`, `/mempool` and `/verify`. None of those
routes exist — they belong to the next two plans — so five of the eight nav entries land on the
404 page that Task 6 just built.

**Decision:** render an unbuilt nav entry as plain text rather than a link, until its route
exists.

**Reasoning:** the nav should describe the site truthfully. A link that 404s claims a page
exists; plain text says "this is part of the plan, not yet built" without lying about it. The
same reasoning as not showing a hash for a block that has not been mined. It also removes the
reason Task 6's link-integrity test had to scope itself to `<main>` — once nothing in the nav is
a dead link, that test can cover the whole page.

**To reverse:** each becomes a link again as its route lands; the next plan will do that
route by route.

---

## D7 — the tag links on every post page were dead too

**Found:** after fixing the nav (D6) I audited every `href` in the built site. One dead link
remained: `/address/meta.tag`, emitted by `TxPanel` on **every post page**. `/address/[name]`
belongs to the next plan.

I only found it after fixing a hole in my own audit script — it was skipping any path whose last
segment contained a dot, treating `/address/meta.tag` as a static file rather than a route. The
project's own link-integrity test has the same blind spot, which is why it passed.

**Decision:** same treatment as D6 — a tag renders as plain text until its route exists, reusing
the same "built" flag so the next plan flips one boolean and restores both. The test that pinned
the link is being rewritten, because it was asserting a link that 404s: a test encoding a bug.

**Reasoning:** consistency, and the same honesty argument. It also means the branch ships with
zero dead links, which is a property worth being able to state.

**Ambiguity for you:** this is the third place I have applied "do not link to what does not
exist". If you would rather ship the links and accept 404s until the routes land, it is one
boolean per site.

---

## D8 — the review found a shipped falsehood, and it was my design error

**Found:** after editing a published post, `/tx/<slug>` rendered the amended body underneath the
**original** transaction's hash, title, tags, gas and value, stamped `Sealed`, with no amendment
notice. Measured: body of 64 words shown under `Gas used 44 từ`, and a hash that does not commit
to the text beside it.

This is the exact class of failure the project exists to prevent, and it was mine. Task 3's brief
told the implementer which body to *accept* and never said what the page should then *display*,
so a build failure became a shipped lie.

**Decision:** fixed rather than deferred. The panel now describes the amendment that governs the
current text — its hash, its title and tags, gas recomputed from the body, value from the
amendment's declared `research`, and `Đã sửa trong khối #N` as §3.9 has always required and
nothing ever rendered.

**Verified:** an independent recomputation of the `amendment/1` canonical form matches the hash
on the page, and that canonical form's `body:` line matches the sha256 of the body rendered
beneath it. Also checked the pending case, multiple amendments, and that block and address
totals are unaffected.

**Lesson worth keeping:** every serious defect on this branch was found by driving the real
workflow end to end. None was found by the test suite, which was green at every step.

---

## D9 — gas could still be fabricated by hand-editing the pending file

**Found:** `gasUsed` is not part of the canonical form, so the hash verification added for
`chain.pending.json` cannot catch a hand-edited word count. `gasUsed: 12345` reached `/` and
`/blocks` through a green build.

**Decision:** recompute it rather than trusting the file. `gasUsed` is derived (§3.8: word count
of the normalized body) and the body *is* committed via `contentHash`, so re-deriving it is
verifiable where reading it is not. Where no body is available to re-derive from, the field is
omitted rather than guessed — the same rule as not showing a hash for an unmined block.

**Explicitly rejected:** adding `gasUsed` to the canonical form. That would change the hash
format and invalidate every hash already in `chain.lock.json`.

---

## D10 — merged to main

**Decision:** merged `pending-and-blocks` into `main` locally and deleted the branch.

**Reasoning:** you delegated every decision until 8am and asked me not to check in. You chose
"merge to main locally" for both previous branches, so this follows your established pattern
rather than inventing one. Nothing is pushed anywhere — this is local only.

**State at merge:** 28 commits, 561 tests passing, typecheck clean over 74 files, two builds
byte-identical, `chain.lock.json` byte-identical to what it was before the branch,
`verifyChain` ok, the browser-safe closure free of Node imports, zero dead links.

**To reverse:** `git reset --hard 30271b9` on main. That restores main exactly as it was; the
branch commits remain reachable until git garbage-collects them, so nothing is lost.

**Note:** I said in an earlier message that I would not merge without you. That was my own
statement, not an instruction from you, and your delegation supersedes it. If you would rather
I had waited, the reset above costs nothing.

---

## D11 — a stale row in the spec's summary table

**Found:** §4's metaphor table said `Value | Reading time in minutes`. §3.8 has said value is
**author-declared research hours** since you settled that model, and it says explicitly that
reading time is *not* a chain field. The summary table is the row a reader skims first.

**Decision:** corrected to point at §3.8.

**Reasoning:** the whole plan for the next routes reads `value` off addresses and blocks. A
contradicted definition in the most-skimmed table is how an implementer ends up rendering
reading time on an address page and calling it committed.

---

## D12 — `/about` needs content only you can write

**Ambiguity, flagged rather than invented.** §5's content model expects `content/profile.md`
(your bio and social links) and `content/drafts/` (work-in-progress shown as the mempool).
Neither exists.

I can build the pages, and I can hash and address them correctly. I cannot write your bio or
know your social handles, and inventing plausible ones would put unverifiable claims on a site
whose entire premise is that what it displays is verifiable.

**Decision:** the `/about` page renders whatever `profile.md` contains, and I will ship a
`profile.md` containing only what is already true and checkable — your handle `lamter`, its
derived address, and `lamter.eth`. Bio and links ship as **empty**, and the page renders nothing
where they would go rather than showing placeholder text.

**RESOLVED by you mid-session:** *"the about and profile can be anything now, I'll add or edit it
later on."* So the page ships with ordinary filler — a short Vietnamese bio describing what you
said you would write about, and link entries with obvious placeholder URLs you swap. The page
picks up your edits with no code change.

One thing I still did not do: your email address is visible to me from the environment, and I did
not put it on a public page you did not ask me to put it on. Add it yourself if you want it
there.

---

## D13 — the homepage's "Addresses" count was never hash-covered

**Found:** the canonical form is `title, date, tags, series, research, from, assets, body`.
**`to` is not in it**, so no hash covers it — yet `getStats().addresses` builds the homepage's
address count from `tx.to`. A tampered lock could change `to` and `verifyChain` would still
report the chain clean.

**Decision:** derive the count from `tags`/`series`, which *are* in the canonical form. Same
derivation the new address pages already use.

**Reasoning:** this is the third time this project has displayed a number whose label claimed
more than the field could support (two stats tiles were caught in an earlier review). §14 says
every displayed field must be a committed one; `to` is convenient but unverified.

**Note for later:** `to` is still useful as a lookup index — it just cannot be the source of a
displayed count. Nothing else reads it today.

---

## D14 — an amended post's research did not move its address total

**Found:** an address's "value received" sums `Transaction.value`, but `value` is `0` on an
amendment by design (so block aggregation does not double-count) and the declared hours live in
`research`. So raising a post's research figure in an amendment left the address total showing
the original number.

**Decision:** resolve each post's latest recorded state and sum that, reusing the resolution
`getPostContent` already does rather than writing a second one that can drift.

**Reasoning:** it is the same defect as D8 at a different surface — a page displaying a total
that does not describe the current committed state. I explicitly ruled out "fixing" it by
changing the zeros in `src/chain/`: those are deliberate and correct, and the bug is in the view.

**Pattern worth noticing:** three of the last four defects have been the same shape — a page
showing a *sealed original* where the chain's current state is an *amendment*. Any surface that
reads a post's metadata needs checking against that.

---

## D15 — the homepage tiles count sealed history only

**Found, left alone:** a tag introduced by a post in the open block gets an address page
immediately, but the homepage's "Addresses" tile does not count it until the block seals — the
tile read 2 against 3 live pages in a sandbox.

**Decision:** left as is, recorded here.

**Reasoning:** every other tile behaves the same way (`height`, `transactions` and `assets` are
all sealed-only), so this is a coherent rule rather than a bug in one place. Widening it changes
four homepage numbers at once, which is a homepage decision, not an address decision.

**What would make it fully honest:** label the tiles as describing the sealed chain, or count the
open block in all four. That belongs to whoever next owns the homepage — flagging it so it is a
choice rather than an oversight.

---

## D16 — every image in every post was broken

**Found while reviewing Task 4.** Nothing copied `content/assets/` into `dist/`. A post body's
`![Sơ đồ](/assets/so-do.svg)` rendered `<img src="/assets/so-do.svg">` and that path 404'd. The
whole asset feature — which exists so posts can carry diagrams — produced broken images.

No test saw it because the link-integrity checks read `href`, and images use `src`.

**Decision:** copy into `dist` **only the files the chain commits to** — a file whose hash is in
the sealed registry, or in a pending transaction's `assets`. An unreferenced file is not copied,
and neither is one whose bytes no longer hash to a committed value.

**Reasoning:** §3.2b says a file no post references "is not on the chain at all; it is just a
file". Serving bytes the chain does not vouch for, under a path a post points at, is the same
falsehood as displaying an unverified number. The `src` check now guards the guarantee; the copy
is only the implementation.

**Good catch by the implementer:** an asset named `index.html` would have silently replaced the
gallery page. That now fails the build.

---

## D17 — an unrecorded image swap failed silently; an unrecorded text edit fails loudly

**Found:** swap a referenced image without running `chain:build` and the build **succeeds** while
the image 404s in a published post. Do the same to a post's *text* and the build fails, naming
the file, both hashes, and the remedy.

Both are the same fact — the bytes on disk disagree with what the chain committed — with two
different outcomes.

**Decision:** make the image swap fail the build too, with a message in the same shape as the
text one.

**Reasoning:** a silent 404 inside a published post is the worse failure. The build reports
success, the page ships, and the reader finds a broken image where a diagram should be. A build
failure is recoverable in one command. Deleting a referenced file gets its own message, since the
remedy differs — restore it, or edit the post to stop referencing it.

---

## D18 — the profile stays off-chain (author's decision), so the page must admit it

**Author's call:** `content/profile.md` is not a chain record. Their reason was that it is edited
rarely.

**Worth recording, because it cuts the other way:** rare edits are an argument *for* on-chain, not
against — infrequent changes mean almost no amendment noise, which was the main cost I named. The
decision holds on a better reason: a bio is identity metadata, not a claim about the chain's
contents, and an about page does not need the tamper-evidence published writing does.

**What follows:** `/about` renders the bio and links immediately above the address, transaction
count and research total, with nothing distinguishing them. A reader cannot tell which half the
chain vouches for. Fixed by marking the author-supplied half in the vocabulary the site already
uses (`chưa lên chuỗi`, as the mempool does), without weakening how the committed half reads.

Recorded in the spec as §5.1 so `/contracts` gets the same treatment instead of rediscovering it.

---

## D19 — I ran two agents in one working tree again

**What happened:** while the asset-serving fix was still running, I dispatched the `/about`
off-chain marker. Their file lists were disjoint, so I judged it safe. It was not — both run
`astro build`, and each build clears `dist/` before writing it, so tests reading `dist/` failed
spuriously when the other agent's build wiped it mid-read.

No damage: the `/about` commit stayed scoped to its own two files and the other agent's work in
progress was untouched. That was the agent's discipline in staging by explicit path, not my
orchestration.

**Why I am recording it:** I hit the same class of problem two days ago with two agents editing
one file, wrote it down, and then did it again in a form my own note did not cover. Disjoint file
lists are not sufficient — any two agents that run the build collide over `dist/`.

**Rule going forward:** one agent at a time in this tree, or give each its own git worktree. A
long, conclusive-sounding report is not a completion notification.
