import { canonicalBlockHeader, canonicalRecordedTx } from './canonical';
import { sha256Hex } from './hash';
import { merkleRootHex } from './merkle';
import type { Block, Chain, Hex, Transaction } from './types';

const ZERO_HASH = '0x' + '00'.repeat(32);

/** A hash is 64 hex characters, so no honest block can demand more zeros. */
const MAX_DIFFICULTY = 64;

export interface BlockVerification {
  height: number;
  hashOk: boolean;
  merkleOk: boolean;
  linkOk: boolean;
  powOk: boolean;
  /** Every transaction hash recomputes, and the block's gas/value sums match. */
  txOk: boolean;
  ok: boolean;
  /** Set only when the block is structurally invalid and could not be checked. */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** `0x` followed by exactly `len` lowercase hex digits. */
function isHexOfLength(value: unknown, len: number): boolean {
  return typeof value === 'string' && new RegExp(`^0x[0-9a-f]{${len}}$`).test(value);
}

/**
 * Exported for the same reason `blockStructuralProblem` is: the pending-block
 * reader validates transactions that never went through a sealed block, and a
 * second definition of "valid transaction" there would drift from this one.
 */
export function transactionStructuralProblem(tx: unknown, index: number): string | null {
  const at = `transaction #${index}`;
  if (!isRecord(tx)) return `${at} is not an object`;
  if (!isHexOfLength(tx.hash, 64)) {
    return `${at} field "hash" is not a 0x-prefixed 64-hex-digit string`;
  }
  if (tx.type !== 'post' && tx.type !== 'amendment') {
    return `${at} field "type" is not "post" or "amendment"`;
  }
  if (typeof tx.date !== 'string') return `${at} field "date" is not a string`;
  if (!isHexOfLength(tx.from, 40)) {
    return `${at} field "from" is not a 0x-prefixed 40-hex-digit string`;
  }
  if (!isHexOfLength(tx.contentHash, 64)) {
    return `${at} field "contentHash" is not a 0x-prefixed 64-hex-digit string`;
  }
  if (!Array.isArray(tx.assets)) return `${at} field "assets" is not an array`;
  for (const a of tx.assets) {
    if (!isHexOfLength(a, 64)) {
      return `${at} has an asset hash that is not a 0x-prefixed 64-hex-digit string`;
    }
  }
  for (const field of ['slug', 'title', 'series', 'amends']) {
    if (!isStringOrNull(tx[field])) return `${at} field "${field}" is not a string or null`;
  }
  for (const field of ['gasUsed', 'value']) {
    if (!isFiniteNumber(tx[field])) return `${at} field "${field}" is not a finite number`;
  }
  if (tx.research != null && !isFiniteNumber(tx.research)) {
    return `${at} field "research" is not a finite number or null`;
  }
  if (!Array.isArray(tx.tags) || tx.tags.some((t) => typeof t !== 'string')) {
    return `${at} field "tags" is not an array of strings`;
  }
  if (!Array.isArray(tx.to) || tx.to.some((t) => typeof t !== 'string')) {
    return `${at} field "to" is not an array of strings`;
  }
  return null;
}

/**
 * §10 — describe a structurally broken block instead of crashing on it. In the
 * browser every byte of `chain.json` is untrusted: a truncated or hand-edited
 * ledger must surface as a reported failure, never as an uncaught TypeError
 * inside the verifier island. Exported so the Node-side lock reader validates
 * against exactly the same shape.
 */
export function blockStructuralProblem(block: unknown): string | null {
  if (!isRecord(block)) return 'block is not an object';
  for (const field of ['height', 'txCount', 'gasUsed', 'value', 'difficulty', 'nonce']) {
    if (!isFiniteNumber(block[field])) return `field "${field}" is not a finite number`;
  }
  const difficulty = block.difficulty as number;
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_DIFFICULTY) {
    return `field "difficulty" must be an integer in 0..${MAX_DIFFICULTY}, got ${difficulty}`;
  }
  for (const field of ['period', 'prevHash', 'merkleRoot', 'timestamp', 'hash']) {
    if (typeof block[field] !== 'string') return `field "${field}" is not a string`;
  }
  if (!Array.isArray(block.transactions)) return 'field "transactions" is not an array';
  for (const [index, tx] of block.transactions.entries()) {
    const problem = transactionStructuralProblem(tx, index);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * §3.2b — a single asset record's own shape, independent of whether it agrees
 * with the transactions. Exported for exactly the reason
 * `blockStructuralProblem` is: the Node-side lock reader and the browser-side
 * verifier must agree on what a valid record is, and two implementations of
 * "valid" drift the moment one of them is edited. Total over untrusted input —
 * returns a descriptive string or null, never throws, for `null`, a
 * non-object, or any missing or wrong-typed field.
 */
export function assetRecordProblem(rec: unknown): string | null {
  if (!isRecord(rec)) return 'is not an object';
  if (typeof rec.tokenId !== 'number' || !Number.isInteger(rec.tokenId) || rec.tokenId < 1) {
    return 'field "tokenId" is not a positive integer';
  }
  if (!isHexOfLength(rec.hash, 64)) {
    return 'field "hash" is not a 0x-prefixed 64-hex-digit string';
  }
  // `file` and `mime` are the two fields a page interpolates — `file` into an
  // `/assets/<file>` URL, `mime` into an attribute — and neither is committed
  // to any hash, so "non-empty string" is not a useful check on them. Require
  // instead exactly the shape the minting side can produce: `referencedAssets`
  // captures `[A-Za-z0-9._-]+` and `hashAssetFile` rejects `.` and `..`, and
  // `mimeTypeFor` returns a type/subtype from a fixed table. No honestly minted
  // record can fail this; a hand-edited `<script>` or `../../../etc/passwd`
  // cannot pass it.
  if (typeof rec.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(rec.file) || rec.file === '.' || rec.file === '..') {
    return 'field "file" is not a plain asset filename';
  }
  if (typeof rec.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(rec.mime)) {
    return 'field "mime" is not a type/subtype media type';
  }
  if (typeof rec.bytes !== 'number' || !Number.isFinite(rec.bytes) || rec.bytes < 0) {
    return 'field "bytes" is not a non-negative number';
  }
  if (typeof rec.mintedIn !== 'number' || !Number.isInteger(rec.mintedIn) || rec.mintedIn < 0) {
    return 'field "mintedIn" is not a non-negative integer';
  }
  return null;
}

/**
 * Recompute a transaction's hash from the fields the ledger records. Returns
 * null when the record cannot produce a canonical form at all, which is itself
 * a verification failure.
 *
 * The canonical form lives in `canonical.ts` so `readPending` can recompute a
 * pending transaction's hash against exactly the same definition this uses for
 * sealed ones.
 */
async function expectedTxHash(tx: Transaction): Promise<Hex | null> {
  const canonical = canonicalRecordedTx(tx);
  return canonical === null ? null : sha256Hex(canonical);
}

/**
 * The Merkle root only proves the *recorded* transaction hashes. Without this,
 * rewriting a transaction's title and value and leaving its hash alone passes
 * every other check — a verifier that reports clean on a forged post is worse
 * than none at all.
 */
async function transactionsOk(block: Block): Promise<boolean> {
  for (const tx of block.transactions) {
    const expected = await expectedTxHash(tx);
    if (expected === null || expected !== tx.hash) return false;
  }
  const gas = block.transactions.reduce((s, t) => s + t.gasUsed, 0);
  const value = block.transactions.reduce((s, t) => s + t.value, 0);
  return block.gasUsed === gas && block.value === Number(value.toFixed(1));
}

/**
 * §7 — pure verification, imported by both the build and the browser.
 * It must never gain a Node-only dependency.
 *
 * `difficulty` is the chain's declared floor; proof of work itself is checked
 * against the difficulty committed in the block's own mined header, so a chain
 * whose blocks were mined at different targets still verifies.
 */
export async function verifyBlock(
  block: Block,
  prev: Block | null,
  difficulty: number,
): Promise<BlockVerification> {
  const problem = blockStructuralProblem(block);
  if (problem !== null) {
    const height = isRecord(block) && isFiniteNumber(block.height) ? (block.height as number) : -1;
    return {
      height,
      hashOk: false,
      merkleOk: false,
      linkOk: false,
      powOk: false,
      txOk: false,
      ok: false,
      reason: problem,
    };
  }

  const expectedHash = await sha256Hex(
    canonicalBlockHeader({
      height: block.height,
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      timestamp: block.timestamp,
      txCount: block.txCount,
      gasUsed: block.gasUsed,
      difficulty: block.difficulty,
      nonce: block.nonce,
    }),
  );
  const expectedRoot = await merkleRootHex(block.transactions.map((t) => t.hash));

  const hashOk = expectedHash === block.hash && block.txCount === block.transactions.length;
  const merkleOk = expectedRoot === block.merkleRoot;
  const linkOk =
    prev === null
      ? block.prevHash === ZERO_HASH && block.height === 0
      : block.prevHash === prev.hash && block.height === prev.height + 1;
  const powOk =
    block.hash.startsWith('0x' + '0'.repeat(block.difficulty)) && block.difficulty >= difficulty;
  const txOk = await transactionsOk(block);

  return {
    height: block.height,
    hashOk,
    merkleOk,
    linkOk,
    powOk,
    txOk,
    ok: hashOk && merkleOk && linkOk && powOk && txOk,
  };
}

/**
 * §3.2b — the asset registry is derived data outside the mined header, so it
 * needs its own check: every referenced hash has exactly one entry, every
 * entry is referenced, mint blocks match first appearance, and token ids run
 * 1..n in that same order. Total over untrusted input, like the rest of this
 * module.
 *
 * Note the limit of what this proves: `file`, `mime` and `bytes` are committed
 * to no hash anywhere on the chain — only the asset's content hash is — so they
 * are shape-checked here but not authenticatable, and `/verify` reporting clean
 * says nothing about whether they were edited.
 */
function registryProblem(chain: Chain): string | null {
  if (!Array.isArray(chain.assets)) return 'assets is not an array';

  const firstSeen = new Map<Hex, number>();
  const order: Hex[] = [];
  for (const block of chain.blocks) {
    // A block that is not even an object (e.g. `null`) already fails
    // structurally and drags `ok` to false on its own; this loop must still
    // not throw walking past it to look for asset references.
    if (!isRecord(block) || !Array.isArray(block.transactions)) continue;
    for (const tx of block.transactions) {
      if (!isRecord(tx) || !Array.isArray(tx.assets)) continue;
      for (const hash of tx.assets) {
        if (typeof hash !== 'string' || firstSeen.has(hash)) continue;
        firstSeen.set(hash, isFiniteNumber(block.height) ? (block.height as number) : NaN);
        order.push(hash);
      }
    }
  }

  if (chain.assets.length !== order.length) {
    return `registry holds ${chain.assets.length} assets but transactions reference ${order.length}`;
  }
  for (let i = 0; i < order.length; i++) {
    const rec = chain.assets[i];
    const shape = assetRecordProblem(rec);
    if (shape !== null) return `asset #${i} ${shape}`;
    if (rec!.hash !== order[i]) return `asset #${i} is out of first-appearance order`;
    if (rec!.tokenId !== i + 1) return `asset #${i} has tokenId ${String(rec!.tokenId)}, expected ${i + 1}`;
    if (rec!.mintedIn !== firstSeen.get(order[i]!)) {
      return `asset ${order[i]} claims mintedIn ${String(rec!.mintedIn)} but first appears in block #${String(firstSeen.get(order[i]!))}`;
    }
  }
  return null;
}

export interface ChainVerification {
  ok: boolean;
  blocks: BlockVerification[];
  /**
   * Set only when the asset registry itself is inconsistent. Without it a
   * registry-only failure reports `ok: false` with every block green and no
   * stated cause anywhere — the worst failure state for a project whose whole
   * premise is legible verification.
   */
  registry?: string;
}

/**
 * §7 — the same verification, one block at a time.
 *
 * The browser's entry point, and the reason it exists: `verifyChain` answers
 * only when the whole chain is done, which is right for a build and wrong for
 * a tab. A reader who fetched `/chain.json` and got nothing on screen until
 * every block had been hashed would be watching a page that looks broken, and
 * on a long chain would be watching it for a while. This yields a verdict per
 * block as it lands.
 *
 * `verifyChain` is expressed through this rather than beside it: two
 * implementations of "is this chain valid" would be two answers the moment one
 * of them was edited, and the whole point of §7 is that the build and the
 * reader's tab prove the same thing.
 *
 * The **return value** is the asset registry's problem, or null — chain-level
 * and not per-block, so it cannot be yielded as one. `for await` discards it,
 * which is exactly right for a caller that only wants blocks; a caller that
 * wants the whole verdict (`verifyChain`, and the `/verify` island) drives
 * `.next()` and reads the final `value`. Without it the browser check would be
 * strictly weaker than the build's, and a chain whose registry disagrees with
 * its transactions would report clean in the one place a reader looks.
 *
 * Total over untrusted input, like the rest of this module: every byte of
 * `chain.json` arrives over a network, and a mangled document must produce a
 * verdict, never an exception.
 */
export async function* verifyChainStream(chain: Chain): AsyncGenerator<BlockVerification, string | null> {
  if (!isRecord(chain) || !Array.isArray(chain.blocks)) {
    return 'chain is not an object with a "blocks" array';
  }
  const difficulty = isFiniteNumber(chain.difficulty) ? chain.difficulty : 0;

  let prev: Block | null = null;
  for (const block of chain.blocks) {
    const result = await verifyBlock(block, prev, difficulty);
    // A structurally broken block cannot be a parent: leave `prev` in place so
    // the next block reports a link failure rather than crashing on it.
    if (result.reason === undefined) prev = block;
    yield result;
  }
  return registryProblem(chain);
}

export interface TxVerification {
  /**
   * The hash of the record the chain's newest word on this post *is* — the
   * newest amendment's, or the original post transaction's (§3.9). `null` when
   * no such record could be found at all.
   */
  hash: Hex | null;
  /** The height of the block that sealed it, or `null` while it is unsealed. */
  height: number | null;
  /** False while the governing record is still in the open block (§3.6). */
  sealed: boolean;
  /** The record the page names is the one the chain currently governs this post with. */
  recordOk: boolean;
  /** The served canonical source hashes to that record's committed `contentHash`. */
  bodyOk: boolean;
  /** That record's own hash recomputes from its fields, including `contentHash`. */
  txOk: boolean;
  /**
   * The block's Merkle root rebuilds from its transaction hashes, this one
   * among them.
   *
   * **`null` is not `true`.** A pending record has no mined block, so there is
   * no root to rebuild and no check was run — reporting `false` would accuse an
   * honest chain, and reporting `true` would claim a check that never happened.
   */
  merkleOk: boolean | null;
  /** The block header rehashes to its recorded hash and meets its own difficulty. `null` as above. */
  blockOk: boolean | null;
  ok: boolean;
  /** Set only when no verdict could be reached — nothing below it was checked. */
  reason?: string;
}

function unverifiable(reason: string): TxVerification {
  return {
    hash: null,
    height: null,
    sealed: false,
    recordOk: false,
    bodyOk: false,
    txOk: false,
    merkleOk: null,
    blockOk: null,
    ok: false,
    reason,
  };
}

/**
 * §7 — one transaction, from the raw text it was written in through to the
 * hash of the block that sealed it.
 *
 * `verifyChain` proves the ledger is internally consistent. It cannot prove
 * that the words a reader just read are the words that were hashed: the ledger
 * stores a `contentHash` and no body at all (§3.1), so the text and the chain
 * only meet when someone hashes the text. That is the one link this adds, and
 * it is the reason the site publishes each post's canonical source.
 *
 * Four links, in order, and each is a separate field because a reader is owed
 * the answer to *which* one broke:
 *
 *  1. `recordOk` — the transaction the page names is the chain's newest record
 *     for this slug. Resolved here from the documents rather than believed from
 *     the page, so a page printing some other transaction's hash is caught
 *     rather than obeyed;
 *  2. `bodyOk`   — the body handed in hashes to that record's `contentHash`;
 *  3. `txOk`     — that record's hash recomputes from its own fields, the
 *     `contentHash` among them. Without this a forged title passes everything
 *     else, which is the same reason `transactionsOk` exists;
 *  4. `merkleOk` / `blockOk` — the block's Merkle root rebuilds from its
 *     transaction hashes, and its header rehashes to the hash it was mined to.
 *
 * `pendingTxs` is the open block's recorded transactions, or `null`. Taken as a
 * bare array and **not** as a `PendingLock`: that type lives in `pending.ts`,
 * which imports the filesystem module, and this file ships to browsers. Even
 * the specifier is unspellable here — the browser-safety guard in
 * `tests/chain/verify.test.ts` is a substring check over this whole file, on
 * purpose, so that a `require` or a runtime-built string cannot slip past the
 * import walk. It caught this sentence's first draft.
 *
 * What this does NOT prove, and the caller must not imply: that the block sits
 * on the chain the rest of the ledger describes. `prevHash` links, the chain's
 * difficulty floor and the asset registry are `verifyChain`'s job — `/verify`
 * runs it over every block. This is one transaction, checked to the depth one
 * transaction can be checked.
 *
 * Total over untrusted input, like everything else here: every byte arrives
 * over a network, and a mangled document must produce a verdict, never a throw.
 */
export async function verifyTransaction(
  slug: string,
  body: string,
  claimedHash: Hex,
  chain: Chain,
  pendingTxs: readonly Transaction[] | null,
): Promise<TxVerification> {
  if (!isRecord(chain) || !Array.isArray(chain.blocks)) {
    return unverifiable('chain is not an object with a "blocks" array');
  }

  // Structurally broken blocks are walked past rather than crashed on, and
  // sorted by height rather than trusted in array order — `latestAmendment` in
  // `src/site/chain-data.ts` documents why nothing may assume the ledger is
  // height-ordered, and this is the browser's copy of that same §3.9 walk.
  const blocks: Block[] = [];
  for (const block of chain.blocks) {
    if (blockStructuralProblem(block) === null) blocks.push(block as Block);
  }
  blocks.sort((a, b) => a.height - b.height);

  const pending: Transaction[] = [];
  if (Array.isArray(pendingTxs)) {
    for (const [index, tx] of pendingTxs.entries()) {
      if (transactionStructuralProblem(tx, index) === null) pending.push(tx as Transaction);
    }
  }

  // The original post transaction. Sealed history first, then the open block:
  // a slug cannot be in both, because `buildChain` represents a later edit to a
  // sealed post as an amendment rather than as a second post (§3.9).
  let original: Transaction | null = null;
  let block: Block | null = null;
  for (const b of blocks) {
    for (const tx of b.transactions) {
      if (tx.type === 'post' && tx.slug === slug) {
        original = tx;
        block = b;
      }
    }
  }
  if (original === null) {
    for (const tx of pending) {
      if (tx.type === 'post' && tx.slug === slug) original = tx;
    }
  }
  if (original === null) {
    return unverifiable(`no post transaction on the chain carries the slug "${slug}"`);
  }

  // §3.9 — the newest amendment governs. Everything in the open block is newer
  // than everything sealed, so it is searched first; the sealed blocks are then
  // walked in ascending height keeping the last match, because walking them the
  // other way settles on the *oldest* amendment and would report a mismatch on
  // a post that is perfectly in order.
  let governing = original;
  let newestPending: Transaction | null = null;
  for (const tx of pending) {
    if (tx.type === 'amendment' && tx.amends === original.hash) newestPending = tx;
  }
  if (newestPending !== null) {
    governing = newestPending;
    block = null;
  } else {
    for (const b of blocks) {
      for (const tx of b.transactions) {
        if (tx.type === 'amendment' && tx.amends === original.hash) {
          governing = tx;
          block = b;
        }
      }
    }
  }

  const recordOk = governing.hash === claimedHash;
  const bodyOk = (await sha256Hex(body)) === governing.contentHash;
  const expected = await expectedTxHash(governing);
  const txOk = expected !== null && expected === governing.hash;

  let merkleOk: boolean | null = null;
  let blockOk: boolean | null = null;
  if (block !== null) {
    // `verifyBlock` and not a second header recomputation here: two definitions
    // of "this block is what it says it is" would be two answers the moment one
    // was edited, which is the whole reason §7 insists on one module.
    const sealedIn = block;
    const prev = blocks.find((b) => b.height === sealedIn.height - 1) ?? null;
    const difficulty = isFiniteNumber(chain.difficulty) ? chain.difficulty : 0;
    const result = await verifyBlock(sealedIn, prev, difficulty);
    // The inclusion half is stated rather than assumed. It is true by
    // construction today — `governing` was found inside `block.transactions` —
    // and the label promises it, so it is checked where the label is answered.
    merkleOk = result.merkleOk && sealedIn.transactions.some((t) => t.hash === governing.hash);
    blockOk = result.hashOk && result.powOk;
  }

  return {
    hash: governing.hash,
    height: block === null ? null : block.height,
    sealed: block !== null,
    recordOk,
    bodyOk,
    txOk,
    merkleOk,
    blockOk,
    ok: recordOk && bodyOk && txOk && merkleOk !== false && blockOk !== false,
  };
}

export async function verifyChain(chain: Chain): Promise<ChainVerification> {
  // Kept ahead of the stream, not folded into it: this is the one input shape
  // for which `verifyChain` answers a bare `{ ok: false, blocks: [] }` with no
  // `registry` key at all, and that is behaviour callers already depend on.
  if (!isRecord(chain) || !Array.isArray(chain.blocks)) {
    return { ok: false, blocks: [] };
  }

  const blocks: BlockVerification[] = [];
  const stream = verifyChainStream(chain);
  let step = await stream.next();
  while (step.done !== true) {
    blocks.push(step.value);
    step = await stream.next();
  }
  const registry = step.value;
  const ok = blocks.every((b) => b.ok) && registry === null;
  return registry === null ? { ok, blocks } : { ok, blocks, registry };
}
