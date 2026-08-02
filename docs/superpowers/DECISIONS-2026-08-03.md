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
