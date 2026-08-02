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
