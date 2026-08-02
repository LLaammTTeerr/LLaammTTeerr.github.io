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
