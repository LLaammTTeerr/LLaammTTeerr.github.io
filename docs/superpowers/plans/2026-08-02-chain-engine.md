# Chain Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-TypeScript chain engine that turns a directory of Markdown posts into a verifiable `chain.lock.json` — real SHA-256 transaction hashes, Merkle roots, mined proof-of-work nonces, monthly block sealing with empty blocks, and amendment detection.

**Architecture:** Nine small single-responsibility modules under `src/chain/`, each independently testable. Hashing is split into a browser-safe async module (Web Crypto, reused later by the in-browser verifier) and a Node-only sync module used exclusively by the miner for speed. Sealed blocks are frozen in a committed lock file and never recomputed. The current date is an explicit injected parameter, never an ambient call, so the golden-file determinism test is possible.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, Vitest, `gray-matter` for frontmatter, `tsx` for running the CLI.

This plan implements the spec at `docs/superpowers/specs/2026-08-02-blockchain-explorer-blog-design.md`. Section references below (§3.2, §3.6, …) point into that spec.

## Global Constraints

- **Node ≥ 20** — required for a stable global `globalThis.crypto.subtle`.
- **`src/chain/hash.ts` must never import `node:crypto`.** It is bundled for the browser later. Node-only sync hashing lives in `src/chain/hash.node.ts` and may only be imported by `mine.ts`.
- **No module in `src/chain/` may read the clock.** No `Date.now()`, no argless `new Date()`. The current date arrives as a `now: string` parameter in `YYYY-MM-DD` form.
- **Hex values** are lowercase and `0x`-prefixed. Hashes are 64 hex chars (32 bytes); addresses are 40 hex chars (20 bytes).
- **Format version prefixes are literal and exact:** `tx/1`, `block/1`, `addr/1`.
- **Canonical strings join with `\n`** and have no trailing newline.
- **`research` always serializes to exactly one decimal place** (§3.2).
- **Difficulty is 5, max 4 transactions per block, sealing period is the calendar month** (§3.4, §3.6). All three are config values, never hardcoded outside `chain.config.ts`.
- **Sealed blocks are immutable.** Nothing may rewrite a block already present in the lock file.

---

### Task 1: Project scaffold and the hashing primitives

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/chain/hash.ts`
- Create: `src/chain/hash.node.ts`
- Test: `tests/chain/hash.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toHex(bytes: Uint8Array): string` — lowercase, no `0x` prefix
  - `fromHex(hex: string): Uint8Array` — accepts with or without `0x`
  - `utf8(s: string): Uint8Array`
  - `sha256(data: Uint8Array | string): Promise<Uint8Array>`
  - `sha256Hex(data: Uint8Array | string): Promise<string>` — returns `0x…`
  - `sha256SyncHex(data: string): string` (from `hash.node.ts`) — returns `0x…`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "chain-blog",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "chain:build": "tsx scripts/build-chain.ts"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {
    "gray-matter": "^4.0.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests", "scripts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
.astro/
```

Note: `chain.lock.json` is deliberately **not** ignored. It is the ledger and must be committed.

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: completes, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 6: Write the failing test**

Create `tests/chain/hash.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toHex, fromHex, utf8, sha256, sha256Hex } from '../../src/chain/hash';
import { sha256SyncHex } from '../../src/chain/hash.node';

describe('hex helpers', () => {
  it('round-trips bytes through hex', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xff, 0xa9]);
    expect(toHex(bytes)).toBe('000fffa9');
    expect(Array.from(fromHex('000fffa9'))).toEqual([0x00, 0x0f, 0xff, 0xa9]);
  });

  it('accepts a 0x prefix when decoding', () => {
    expect(Array.from(fromHex('0xff00'))).toEqual([0xff, 0x00]);
  });
});

describe('sha256', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the known digest of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes a Uint8Array identically to the equivalent string', async () => {
    expect(await sha256Hex(utf8('abc'))).toBe(await sha256Hex('abc'));
  });

  it('returns 32 bytes', async () => {
    expect((await sha256('abc')).length).toBe(32);
  });

  it('handles Vietnamese text as UTF-8', async () => {
    // Must not throw and must be stable.
    const a = await sha256Hex('Ghi chú thuật toán');
    const b = await sha256Hex('Ghi chú thuật toán');
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('sha256SyncHex', () => {
  it('agrees with the async Web Crypto implementation', async () => {
    for (const input of ['', 'abc', 'Ghi chú thuật toán', 'block/1\nheight:0']) {
      expect(sha256SyncHex(input)).toBe(await sha256Hex(input));
    }
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/chain/hash.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/hash`.

- [ ] **Step 8: Implement `src/chain/hash.ts`**

```ts
const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return '0x' + toHex(await sha256(data));
}
```

- [ ] **Step 9: Implement `src/chain/hash.node.ts`**

```ts
import { createHash } from 'node:crypto';

/**
 * Synchronous SHA-256, Node-only. Exists solely because mining performs ~1M
 * hashes per block and awaiting a Promise per attempt is far too slow.
 * Only `mine.ts` may import this module — `hash.ts` is bundled for the browser.
 */
export function sha256SyncHex(data: string): string {
  return '0x' + createHash('sha256').update(data, 'utf8').digest('hex');
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run tests/chain/hash.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/chain/hash.ts src/chain/hash.node.ts tests/chain/hash.test.ts
git commit -m "feat(chain): scaffold project and add hashing primitives"
```

---

### Task 2: Canonical serialization

Implements §3.1 (content normalization), §3.2 (transaction hash), §3.4 (block header), §3.8 (gas), §3.9 (amendment form).

**Files:**
- Create: `src/chain/types.ts`
- Create: `src/chain/canonical.ts`
- Test: `tests/chain/canonical.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (pure string functions).
- Produces:
  - `type Hex = string`
  - `interface PostInput`, `interface Transaction`, `interface Block`, `interface Chain`, `interface BlockHeader`
  - `normalizeBody(body: string): string`
  - `wordCount(normalizedBody: string): number`
  - `formatResearch(hours: number): string`
  - `canonicalPostTx(p: CanonicalPostFields): string`
  - `canonicalAmendmentTx(a: CanonicalAmendmentFields): string`
  - `canonicalBlockHeader(h: BlockHeader): string`

- [ ] **Step 1: Create `src/chain/types.ts`**

```ts
export type Hex = string;

export type TxType = 'post' | 'amendment';

/** A post as parsed from disk, before it becomes a transaction. */
export interface PostInput {
  slug: string;
  title: string;
  date: string;          // YYYY-MM-DD
  tags: string[];        // already slugified
  series: string | null; // already slugified
  research: number;      // hours
  summary: string;
  body: string;          // raw markdown, not yet normalized
}

export interface Transaction {
  hash: Hex;
  type: TxType;
  slug: string | null;      // null for amendments
  title: string | null;     // null for amendments
  date: string;
  tags: string[];
  series: string | null;
  from: Hex;
  to: Hex[];                // tag/series addresses; empty for amendments
  contentHash: Hex;
  gasUsed: number;          // word count; 0 for amendments
  value: number;            // research hours; 0 for amendments
  amends: Hex | null;
}

export interface BlockHeader {
  height: number;
  prevHash: Hex;
  merkleRoot: Hex;
  timestamp: string;   // ISO 8601 UTC
  txCount: number;
  gasUsed: number;
  difficulty: number;
  nonce: number;
}

export interface Block extends BlockHeader {
  hash: Hex;
  period: string;      // YYYY-MM, the calendar month this block belongs to
  value: number;       // sum of transaction values
  transactions: Transaction[];
}

export interface Chain {
  version: 1;
  difficulty: number;
  blocks: Block[];
}
```

Note: `value` is on `Block` but deliberately **not** on `BlockHeader`, because §3.4 excludes it from the header hash. It stays verifiable because it is the sum of transaction values, and transactions are committed via the Merkle root.

- [ ] **Step 2: Write the failing test**

Create `tests/chain/canonical.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeBody,
  wordCount,
  formatResearch,
  canonicalPostTx,
  canonicalAmendmentTx,
  canonicalBlockHeader,
} from '../../src/chain/canonical';

describe('normalizeBody', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeBody('a\r\nb\rc')).toBe('a\nb\nc\n');
  });

  it('strips trailing whitespace from each line', () => {
    expect(normalizeBody('a   \nb\t\n')).toBe('a\nb\n');
  });

  it('collapses trailing newlines to exactly one', () => {
    expect(normalizeBody('a\n\n\n')).toBe('a\n');
  });

  it('adds a trailing newline when absent', () => {
    expect(normalizeBody('a')).toBe('a\n');
  });

  it('preserves interior blank lines', () => {
    expect(normalizeBody('a\n\nb')).toBe('a\n\nb\n');
  });

  it('is idempotent', () => {
    const once = normalizeBody('a  \r\n\r\nb\n\n\n');
    expect(normalizeBody(once)).toBe(once);
  });
});

describe('wordCount', () => {
  it('counts whitespace-separated tokens', () => {
    expect(wordCount('mot hai ba\n')).toBe(3);
  });

  it('returns 0 for an empty body', () => {
    expect(wordCount('\n')).toBe(0);
  });

  it('does not double-count runs of whitespace', () => {
    expect(wordCount('a    b\n\n\tc\n')).toBe(3);
  });
});

describe('formatResearch', () => {
  it('always emits exactly one decimal place', () => {
    expect(formatResearch(12.5)).toBe('12.5');
    expect(formatResearch(12)).toBe('12.0');
    expect(formatResearch(0)).toBe('0.0');
    expect(formatResearch(40)).toBe('40.0');
  });

  it('collapses equivalent literals to one representation', () => {
    expect(formatResearch(12.5)).toBe(formatResearch(12.50));
  });
});

describe('canonicalPostTx', () => {
  const base = {
    title: "Mo's Algorithm",
    date: '2026-07-28',
    tags: ['cp', 'algorithm'],
    series: 'ghi-chu-thuat-toan',
    research: 12.5,
    from: '0xaaaa',
    contentHash: '0xbbbb',
  };

  it('emits the exact field order from the spec', () => {
    expect(canonicalPostTx(base)).toBe(
      [
        'tx/1',
        "title:Mo's Algorithm",
        'date:2026-07-28',
        'tags:algorithm,cp',
        'series:ghi-chu-thuat-toan',
        'research:12.5',
        'from:0xaaaa',
        'body:0xbbbb',
      ].join('\n'),
    );
  });

  it('sorts tags so declaration order cannot change the hash', () => {
    expect(canonicalPostTx({ ...base, tags: ['algorithm', 'cp'] })).toBe(
      canonicalPostTx({ ...base, tags: ['cp', 'algorithm'] }),
    );
  });

  it('lowercases tags', () => {
    expect(canonicalPostTx({ ...base, tags: ['CP', 'Algorithm'] })).toContain(
      'tags:algorithm,cp',
    );
  });

  it('renders a null series as an empty value', () => {
    expect(canonicalPostTx({ ...base, series: null })).toContain('\nseries:\n');
  });

  it('has no trailing newline', () => {
    expect(canonicalPostTx(base).endsWith('\n')).toBe(false);
  });
});

describe('canonicalAmendmentTx', () => {
  it('emits the exact field order from the spec', () => {
    expect(
      canonicalAmendmentTx({
        date: '2026-07-28',
        amends: '0xdead',
        from: '0xaaaa',
        contentHash: '0xbeef',
      }),
    ).toBe(
      [
        'tx/1',
        'type:amendment',
        'date:2026-07-28',
        'amends:0xdead',
        'from:0xaaaa',
        'body:0xbeef',
      ].join('\n'),
    );
  });
});

describe('canonicalBlockHeader', () => {
  it('emits the exact field order from the spec', () => {
    expect(
      canonicalBlockHeader({
        height: 42,
        prevHash: '0x00',
        merkleRoot: '0x11',
        timestamp: '2026-07-31T00:00:00Z',
        txCount: 4,
        gasUsed: 11240,
        difficulty: 5,
        nonce: 148203,
      }),
    ).toBe(
      [
        'block/1',
        'height:42',
        'prevHash:0x00',
        'merkleRoot:0x11',
        'timestamp:2026-07-31T00:00:00Z',
        'txCount:4',
        'gasUsed:11240',
        'difficulty:5',
        'nonce:148203',
      ].join('\n'),
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/chain/canonical.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/canonical`.

- [ ] **Step 4: Implement `src/chain/canonical.ts`**

```ts
import type { BlockHeader, Hex } from './types';

/** §3.1 — normalize before hashing. Applied to raw Markdown, never to rendered HTML. */
export function normalizeBody(body: string): string {
  const lf = body.replace(/\r\n?/g, '\n');
  const trimmed = lf
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  return trimmed.replace(/\n*$/, '') + '\n';
}

/** §3.8 — gas is the word count of the normalized body. */
export function wordCount(normalizedBody: string): number {
  return normalizedBody.match(/\S+/g)?.length ?? 0;
}

/** §3.2 — fixed at one decimal place so 12.5, 12.50 and 12.500 cannot diverge. */
export function formatResearch(hours: number): string {
  return hours.toFixed(1);
}

export interface CanonicalPostFields {
  title: string;
  date: string;
  tags: string[];
  series: string | null;
  research: number;
  from: Hex;
  contentHash: Hex;
}

export function canonicalPostTx(p: CanonicalPostFields): string {
  const tags = p.tags.map((t) => t.toLowerCase()).sort();
  return [
    'tx/1',
    `title:${p.title}`,
    `date:${p.date}`,
    `tags:${tags.join(',')}`,
    `series:${p.series ?? ''}`,
    `research:${formatResearch(p.research)}`,
    `from:${p.from}`,
    `body:${p.contentHash}`,
  ].join('\n');
}

export interface CanonicalAmendmentFields {
  date: string;
  amends: Hex;
  from: Hex;
  contentHash: Hex;
}

export function canonicalAmendmentTx(a: CanonicalAmendmentFields): string {
  return [
    'tx/1',
    'type:amendment',
    `date:${a.date}`,
    `amends:${a.amends}`,
    `from:${a.from}`,
    `body:${a.contentHash}`,
  ].join('\n');
}

export function canonicalBlockHeader(h: BlockHeader): string {
  return [
    'block/1',
    `height:${h.height}`,
    `prevHash:${h.prevHash}`,
    `merkleRoot:${h.merkleRoot}`,
    `timestamp:${h.timestamp}`,
    `txCount:${h.txCount}`,
    `gasUsed:${h.gasUsed}`,
    `difficulty:${h.difficulty}`,
    `nonce:${h.nonce}`,
  ].join('\n');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/chain/canonical.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 6: Commit**

```bash
git add src/chain/types.ts src/chain/canonical.ts tests/chain/canonical.test.ts
git commit -m "feat(chain): add canonical serialization for txs and block headers"
```

---

### Task 3: Merkle tree

Implements §3.3.

**Files:**
- Create: `src/chain/merkle.ts`
- Test: `tests/chain/merkle.test.ts`

**Interfaces:**
- Consumes: `sha256` from `src/chain/hash`.
- Produces:
  - `merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array>`
  - `merkleRootHex(leafHashes: Hex[]): Promise<Hex>` — takes `0x…` strings, returns `0x…`

- [ ] **Step 1: Write the failing test**

Create `tests/chain/merkle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { merkleRoot, merkleRootHex } from '../../src/chain/merkle';
import { sha256, toHex, fromHex } from '../../src/chain/hash';

/** Concatenate two digests, matching the tree's internal-node rule. */
function cat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe('merkleRoot', () => {
  it('returns 32 zero bytes for an empty set', async () => {
    const root = await merkleRoot([]);
    expect(root.length).toBe(32);
    expect(toHex(root)).toBe('00'.repeat(32));
  });

  it('returns the leaf itself for a single leaf', async () => {
    const a = await sha256('a');
    expect(toHex(await merkleRoot([a]))).toBe(toHex(a));
  });

  it('hashes the concatenation for two leaves', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    expect(toHex(await merkleRoot([a, b]))).toBe(toHex(await sha256(cat(a, b))));
  });

  it('duplicates the last node on an odd level (the Bitcoin rule)', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    const c = await sha256('c');
    const expected = await sha256(
      cat(await sha256(cat(a, b)), await sha256(cat(c, c))),
    );
    expect(toHex(await merkleRoot([a, b, c]))).toBe(toHex(expected));
  });

  it('is order-sensitive', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    expect(toHex(await merkleRoot([a, b]))).not.toBe(toHex(await merkleRoot([b, a])));
  });

  it('handles four leaves as a balanced tree', async () => {
    const [a, b, c, d] = await Promise.all(
      ['a', 'b', 'c', 'd'].map((s) => sha256(s)),
    );
    const expected = await sha256(
      cat(await sha256(cat(a!, b!)), await sha256(cat(c!, d!))),
    );
    expect(toHex(await merkleRoot([a!, b!, c!, d!]))).toBe(toHex(expected));
  });
});

describe('merkleRootHex', () => {
  it('accepts and returns 0x-prefixed hex', async () => {
    const a = await sha256('a');
    const b = await sha256('b');
    const root = await merkleRootHex(['0x' + toHex(a), '0x' + toHex(b)]);
    expect(root).toBe('0x' + toHex(await merkleRoot([a, b])));
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('agrees with the byte-level function on an empty set', async () => {
    expect(await merkleRootHex([])).toBe('0x' + '00'.repeat(32));
  });

  it('round-trips through fromHex', async () => {
    const a = await sha256('a');
    expect(toHex(fromHex('0x' + toHex(a)))).toBe(toHex(a));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/chain/merkle.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/merkle`.

- [ ] **Step 3: Implement `src/chain/merkle.ts`**

```ts
import { fromHex, sha256, toHex } from './hash';
import type { Hex } from './types';

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * §3.3 — standard binary Merkle tree over raw 32-byte digests.
 * Odd levels duplicate their last node (the Bitcoin rule).
 * The root of an empty set is 32 zero bytes.
 */
export async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return new Uint8Array(32);

  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(await sha256(concat(left, right)));
    }
    level = next;
  }
  return level[0]!;
}

export async function merkleRootHex(leafHashes: Hex[]): Promise<Hex> {
  const root = await merkleRoot(leafHashes.map(fromHex));
  return '0x' + toHex(root);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/chain/merkle.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chain/merkle.ts tests/chain/merkle.test.ts
git commit -m "feat(chain): add merkle tree with bitcoin odd-node rule"
```

---

### Task 4: Addresses and slugs

Implements §3.7. The slugifier must handle Vietnamese correctly — this is the one place where getting Unicode wrong produces silently broken URLs.

**Files:**
- Create: `src/chain/address.ts`
- Test: `tests/chain/address.test.ts`

**Interfaces:**
- Consumes: `sha256`, `toHex` from `src/chain/hash`.
- Produces:
  - `slugify(s: string): string`
  - `tagAddress(slug: string): Promise<Hex>` — 20 bytes, `0x` + 40 hex
  - `identityAddress(handle: string): Promise<Hex>`
  - `tagName(slug: string): string` — e.g. `cp.tag`

- [ ] **Step 1: Write the failing test**

Create `tests/chain/address.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slugify, tagAddress, identityAddress, tagName } from '../../src/chain/address';

describe('slugify', () => {
  it('strips Vietnamese diacritics', () => {
    expect(slugify('Ghi chú thuật toán')).toBe('ghi-chu-thuat-toan');
  });

  it('maps đ and Đ, which have no Unicode decomposition', () => {
    expect(slugify('Đường đi')).toBe('duong-di');
  });

  it('handles horned vowels', () => {
    expect(slugify('Tư tưởng')).toBe('tu-tuong');
  });

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(slugify("Mo's  Algorithm -- v2")).toBe('mo-s-algorithm-v2');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  --hello--  ')).toBe('hello');
  });

  it('is idempotent', () => {
    const once = slugify('Ghi chú thuật toán');
    expect(slugify(once)).toBe(once);
  });
});

describe('tagAddress', () => {
  it('produces a 20-byte 0x-prefixed address', async () => {
    expect(await tagAddress('cp')).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('is deterministic', async () => {
    expect(await tagAddress('cp')).toBe(await tagAddress('cp'));
  });

  it('gives different tags different addresses', async () => {
    expect(await tagAddress('cp')).not.toBe(await tagAddress('blockchain'));
  });

  it('is domain-separated from identity addresses', async () => {
    expect(await tagAddress('lamter')).not.toBe(await identityAddress('lamter'));
  });
});

describe('identityAddress', () => {
  it('produces a 20-byte 0x-prefixed address', async () => {
    expect(await identityAddress('lamter')).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('is deterministic', async () => {
    expect(await identityAddress('lamter')).toBe(await identityAddress('lamter'));
  });
});

describe('tagName', () => {
  it('appends the .tag suffix', () => {
    expect(tagName('cp')).toBe('cp.tag');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/chain/address.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/address`.

- [ ] **Step 3: Implement `src/chain/address.ts`**

```ts
import { sha256, toHex } from './hash';
import type { Hex } from './types';

/**
 * NFD decomposition separates most Vietnamese diacritics into combining marks
 * which we then strip. `đ`/`Đ` have no decomposition, so they are mapped
 * explicitly — and must be mapped AFTER the combining-mark strip, since that
 * strip does not touch them.
 */
export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** §3.7 — first 20 bytes of a domain-separated digest. */
async function address(domain: string, value: string): Promise<Hex> {
  const digest = await sha256(`addr/1|${domain}|${value}`);
  return '0x' + toHex(digest).slice(0, 40);
}

export function tagAddress(slug: string): Promise<Hex> {
  return address('tag', slug);
}

export function identityAddress(handle: string): Promise<Hex> {
  return address('identity', handle);
}

export function tagName(slug: string): string {
  return `${slug}.tag`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/chain/address.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chain/address.ts tests/chain/address.test.ts
git commit -m "feat(chain): add vietnamese-aware slugify and address derivation"
```

---

### Task 5: Proof-of-work miner

Implements §3.4. Tests use difficulty 2 so they run in milliseconds; production difficulty is 5.

**Files:**
- Create: `src/chain/mine.ts`
- Test: `tests/chain/mine.test.ts`

**Interfaces:**
- Consumes: `canonicalBlockHeader` from `src/chain/canonical`, `sha256SyncHex` from `src/chain/hash.node`, `BlockHeader` from `src/chain/types`.
- Produces:
  - `mine(header: Omit<BlockHeader, 'nonce'>, difficulty: number): { nonce: number; hash: Hex }`
  - `meetsDifficulty(hash: Hex, difficulty: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/chain/mine.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mine, meetsDifficulty } from '../../src/chain/mine';
import { canonicalBlockHeader } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';
import { sha256SyncHex } from '../../src/chain/hash.node';

const header = {
  height: 0,
  prevHash: '0x' + '00'.repeat(32),
  merkleRoot: '0x' + '11'.repeat(32),
  timestamp: '2026-07-31T00:00:00Z',
  txCount: 1,
  gasUsed: 100,
  difficulty: 2,
};

describe('meetsDifficulty', () => {
  it('accepts a hash with enough leading zeros', () => {
    expect(meetsDifficulty('0x00abcd', 2)).toBe(true);
  });

  it('rejects a hash with too few leading zeros', () => {
    expect(meetsDifficulty('0x0abcde', 2)).toBe(false);
  });

  it('treats difficulty 0 as always satisfied', () => {
    expect(meetsDifficulty('0xffffff', 0)).toBe(true);
  });
});

describe('mine', () => {
  it('finds a nonce whose hash meets the difficulty', () => {
    const { nonce, hash } = mine(header, 2);
    expect(meetsDifficulty(hash, 2)).toBe(true);
    expect(Number.isInteger(nonce)).toBe(true);
    expect(nonce).toBeGreaterThanOrEqual(0);
  });

  it('returns the hash of the header including its nonce', async () => {
    const { nonce, hash } = mine(header, 2);
    expect(hash).toBe(await sha256Hex(canonicalBlockHeader({ ...header, nonce })));
  });

  it('is deterministic — the same header always yields the same nonce', () => {
    expect(mine(header, 2)).toEqual(mine(header, 2));
  });

  it('finds the lowest satisfying nonce', () => {
    const { nonce } = mine(header, 2);
    for (let n = 0; n < nonce; n++) {
      const candidate = sha256SyncHex(canonicalBlockHeader({ ...header, nonce: n }));
      expect(meetsDifficulty(candidate, 2)).toBe(false);
    }
  });

  it('produces different nonces for different headers', () => {
    const a = mine(header, 2).nonce;
    const b = mine({ ...header, height: 1 }, 2).nonce;
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/chain/mine.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/mine`.

- [ ] **Step 3: Implement `src/chain/mine.ts`**

```ts
import { canonicalBlockHeader } from './canonical';
import { sha256SyncHex } from './hash.node';
import type { BlockHeader, Hex } from './types';

export function meetsDifficulty(hash: Hex, difficulty: number): boolean {
  return hash.startsWith('0x' + '0'.repeat(difficulty));
}

/**
 * §3.4 — search nonces upward from 0 until the block hash has `difficulty`
 * leading hex zeros. Returns the lowest satisfying nonce, which makes mining
 * deterministic: the same header always produces the same result.
 *
 * Node-only (uses synchronous hashing). Paid once per block for the lifetime
 * of the site, because sealed blocks are frozen in the lock file.
 */
export function mine(
  header: Omit<BlockHeader, 'nonce'>,
  difficulty: number,
): { nonce: number; hash: Hex } {
  for (let nonce = 0; ; nonce++) {
    const hash = sha256SyncHex(canonicalBlockHeader({ ...header, nonce }));
    if (meetsDifficulty(hash, difficulty)) return { nonce, hash };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/chain/mine.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chain/mine.ts tests/chain/mine.test.ts
git commit -m "feat(chain): add deterministic proof-of-work miner"
```

---

### Task 6: Block sealing and empty-block minting

Implements §3.6 and the timestamp rules of §3.4. This is the most subtle module in the engine — it is the only one that consults elapsed time, and it does so through an injected parameter.

**Files:**
- Create: `src/chain/period.ts`
- Create: `src/chain/seal.ts`
- Test: `tests/chain/period.test.ts`
- Test: `tests/chain/seal.test.ts`

**Interfaces:**
- Consumes: `Transaction` from `src/chain/types`.
- Produces:
  - `monthOf(date: string): string` — `'2026-07-28'` → `'2026-07'`
  - `lastDayOfMonth(period: string): string` — `'2026-02'` → `'2026-02-28'`
  - `nextMonth(period: string): string`
  - `monthRange(from: string, toExclusive: string): string[]`
  - `interface BlockDraft { period: string; transactions: Transaction[] }`
  - `planBlocks(pending: Transaction[], opts: PlanOptions): BlockDraft[]`
  - `interface PlanOptions { fromPeriod: string | null; now: string; maxTxPerBlock: number }`
  - `blockTimestamp(draft: BlockDraft, prevTimestamp: string | null): string`

- [ ] **Step 1: Write the failing test for date arithmetic**

Create `tests/chain/period.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { monthOf, lastDayOfMonth, nextMonth, monthRange } from '../../src/chain/period';

describe('monthOf', () => {
  it('extracts YYYY-MM', () => {
    expect(monthOf('2026-07-28')).toBe('2026-07');
  });
});

describe('lastDayOfMonth', () => {
  it('handles a 31-day month', () => {
    expect(lastDayOfMonth('2026-07')).toBe('2026-07-31');
  });

  it('handles a 30-day month', () => {
    expect(lastDayOfMonth('2026-06')).toBe('2026-06-30');
  });

  it('handles a non-leap February', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
  });

  it('handles a leap February', () => {
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29');
  });

  it('handles December', () => {
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
  });
});

describe('nextMonth', () => {
  it('advances within a year', () => {
    expect(nextMonth('2026-07')).toBe('2026-08');
  });

  it('rolls over the year boundary', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
  });
});

describe('monthRange', () => {
  it('is inclusive of from and exclusive of to', () => {
    expect(monthRange('2026-05', '2026-08')).toEqual(['2026-05', '2026-06', '2026-07']);
  });

  it('returns empty when from equals to', () => {
    expect(monthRange('2026-05', '2026-05')).toEqual([]);
  });

  it('returns empty when from is after to', () => {
    expect(monthRange('2026-09', '2026-05')).toEqual([]);
  });

  it('crosses a year boundary', () => {
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chain/period.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/period`.

- [ ] **Step 3: Implement `src/chain/period.ts`**

```ts
/**
 * Calendar arithmetic on `YYYY-MM` periods and `YYYY-MM-DD` dates.
 * All arithmetic is UTC. No function here reads the clock.
 */

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

function parsePeriod(period: string): { year: number; month: number } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new Error(`invalid period: ${period}`);
  }
  return { year, month };
}

function formatPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function lastDayOfMonth(period: string): string {
  const { year, month } = parsePeriod(period);
  // Day 0 of the following month is the last day of this one.
  const d = new Date(Date.UTC(year, month, 0));
  return `${period}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function nextMonth(period: string): string {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

/** Ascending periods from `from` inclusive to `toExclusive` exclusive. */
export function monthRange(from: string, toExclusive: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor < toExclusive) {
    out.push(cursor);
    cursor = nextMonth(cursor);
  }
  return out;
}
```

Note: lexicographic `<` is correct for zero-padded `YYYY-MM` strings.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/chain/period.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Write the failing test for sealing**

Create `tests/chain/seal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planBlocks, blockTimestamp } from '../../src/chain/seal';
import type { Transaction } from '../../src/chain/types';

function tx(date: string, slug: string): Transaction {
  return {
    hash: `0x${slug}`,
    type: 'post',
    slug,
    title: slug,
    date,
    tags: [],
    series: null,
    from: '0xaaaa',
    to: [],
    contentHash: `0xc${slug}`,
    gasUsed: 100,
    value: 1,
    amends: null,
  };
}

const OPTS = { maxTxPerBlock: 4, fromPeriod: null, now: '2026-08-02' };

describe('planBlocks', () => {
  it('returns nothing when there are no transactions and no prior chain', () => {
    expect(planBlocks([], OPTS)).toEqual([]);
  });

  it('seals a completed month into one block', () => {
    const txs = [tx('2026-07-01', 'a'), tx('2026-07-15', 'b')];
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.period).toBe('2026-07');
    expect(drafts[0]!.transactions.map((t) => t.slug)).toEqual(['a', 'b']);
  });

  it('does not seal the current month when under the size limit', () => {
    const txs = [tx('2026-08-01', 'a')];
    expect(planBlocks(txs, OPTS)).toEqual([]);
  });

  it('seals the current month once the size limit is reached', () => {
    const txs = ['a', 'b', 'c', 'd'].map((s, i) => tx(`2026-08-0${i + 1}`, s));
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.transactions).toHaveLength(4);
  });

  it('leaves the remainder pending after a size-limit seal in the current month', () => {
    const txs = ['a', 'b', 'c', 'd', 'e'].map((s, i) => tx(`2026-08-0${i + 1}`, s));
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.transactions.map((t) => t.slug)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('splits a busy past month into multiple blocks of at most maxTxPerBlock', () => {
    const txs = ['a', 'b', 'c', 'd', 'e'].map((s, i) => tx(`2026-07-0${i + 1}`, s));
    const drafts = planBlocks(txs, OPTS);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.transactions).toHaveLength(4);
    expect(drafts[1]!.transactions.map((t) => t.slug)).toEqual(['e']);
  });

  it('mints an empty block for a silent month between posts', () => {
    const txs = [tx('2026-05-10', 'a'), tx('2026-07-10', 'b')];
    const drafts = planBlocks(txs, OPTS);
    expect(drafts.map((d) => d.period)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(drafts[1]!.transactions).toEqual([]);
  });

  it('mints empty blocks for silent months after the last sealed block', () => {
    const drafts = planBlocks([], { ...OPTS, fromPeriod: '2026-05' });
    expect(drafts.map((d) => d.period)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(drafts.every((d) => d.transactions.length === 0)).toBe(true);
  });

  it('never seals the current month as an empty block', () => {
    const drafts = planBlocks([], { ...OPTS, fromPeriod: '2026-08' });
    expect(drafts).toEqual([]);
  });

  it('is a no-op when re-run at the same clock', () => {
    const txs = [tx('2026-07-01', 'a')];
    expect(planBlocks(txs, OPTS)).toEqual(planBlocks(txs, OPTS));
  });

  it('orders amendments after ordinary transactions within a block', () => {
    const amendment: Transaction = {
      ...tx('2026-07-01', 'z'),
      type: 'amendment',
      slug: null,
      title: null,
      amends: '0xolder',
      gasUsed: 0,
      value: 0,
    };
    const drafts = planBlocks([amendment, tx('2026-07-20', 'a')], OPTS);
    expect(drafts[0]!.transactions.map((t) => t.type)).toEqual(['post', 'amendment']);
  });
});

describe('blockTimestamp', () => {
  it('uses the latest transaction date for a non-empty block', () => {
    const draft = { period: '2026-07', transactions: [tx('2026-07-01', 'a'), tx('2026-07-20', 'b')] };
    expect(blockTimestamp(draft, null)).toBe('2026-07-20T00:00:00Z');
  });

  it('uses the last day of the month for an empty block', () => {
    expect(blockTimestamp({ period: '2026-06', transactions: [] }, null)).toBe(
      '2026-06-30T00:00:00Z',
    );
  });

  it('never goes backwards from the previous block', () => {
    const draft = { period: '2026-07', transactions: [tx('2026-01-01', 'old')] };
    expect(blockTimestamp(draft, '2026-06-30T00:00:00Z')).toBe('2026-06-30T00:00:00Z');
  });

  it('advances past the previous block when the content is newer', () => {
    const draft = { period: '2026-07', transactions: [tx('2026-07-20', 'a')] };
    expect(blockTimestamp(draft, '2026-06-30T00:00:00Z')).toBe('2026-07-20T00:00:00Z');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/chain/seal.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/seal`.

- [ ] **Step 7: Implement `src/chain/seal.ts`**

```ts
import { lastDayOfMonth, monthOf, monthRange, nextMonth } from './period';
import type { Transaction } from './types';

export interface BlockDraft {
  period: string; // YYYY-MM
  transactions: Transaction[];
}

export interface PlanOptions {
  /** Month after the last sealed block, or null if the chain is empty. */
  fromPeriod: string | null;
  /** Injected clock, YYYY-MM-DD. The ONLY time input to the engine. */
  now: string;
  maxTxPerBlock: number;
}

/**
 * §5 — ordinary transactions by date then slug; amendments last, ordered by
 * the hash they amend. Amendments carry the date of the older post they amend,
 * so sorting them by date would scatter them among unrelated posts.
 */
function orderWithinBlock(txs: Transaction[]): Transaction[] {
  const posts = txs.filter((t) => t.type !== 'amendment');
  const amendments = txs.filter((t) => t.type === 'amendment');
  posts.sort((a, b) => a.date.localeCompare(b.date) || (a.slug ?? '').localeCompare(b.slug ?? ''));
  amendments.sort((a, b) => (a.amends ?? '').localeCompare(b.amends ?? ''));
  return [...posts, ...amendments];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * §3.6 — decide which blocks are ready to seal.
 *
 * A block seals when it reaches maxTxPerBlock transactions, or when its
 * calendar month has ended. Complete months with no posts still mint an empty
 * block. The current month is never sealed on the time rule, because it is
 * still open.
 */
export function planBlocks(pending: Transaction[], opts: PlanOptions): BlockDraft[] {
  const currentPeriod = monthOf(opts.now);

  const byPeriod = new Map<string, Transaction[]>();
  for (const tx of pending) {
    const period = monthOf(tx.date);
    const bucket = byPeriod.get(period);
    if (bucket) bucket.push(tx);
    else byPeriod.set(period, [tx]);
  }

  const earliestTxPeriod = [...byPeriod.keys()].sort()[0] ?? null;
  const start = [opts.fromPeriod, earliestTxPeriod]
    .filter((p): p is string => p !== null)
    .sort()[0];
  if (start === undefined) return [];

  const latestTxPeriod = [...byPeriod.keys()].sort().at(-1) ?? start;
  // Walk every month from the start through the later of "last post" and
  // "month before now", so silent months in between are not skipped.
  const endExclusive = nextMonth(
    latestTxPeriod > currentPeriod ? latestTxPeriod : currentPeriod,
  );

  const drafts: BlockDraft[] = [];
  for (const period of monthRange(start, endExclusive)) {
    const txs = orderWithinBlock(byPeriod.get(period) ?? []);
    const isPast = period < currentPeriod;

    if (txs.length === 0) {
      if (isPast) drafts.push({ period, transactions: [] });
      continue;
    }

    const groups = chunk(txs, opts.maxTxPerBlock);
    for (const group of groups) {
      const isFull = group.length === opts.maxTxPerBlock;
      // A partial group in the current month stays pending.
      if (isFull || isPast) drafts.push({ period, transactions: group });
    }
  }

  return drafts;
}

/**
 * §3.4 — timestamps derive from content, never from build time, and never
 * decrease along the chain.
 */
export function blockTimestamp(draft: BlockDraft, prevTimestamp: string | null): string {
  const contentDate =
    draft.transactions.length === 0
      ? lastDayOfMonth(draft.period)
      : draft.transactions.map((t) => t.date).sort().at(-1)!;

  const candidate = `${contentDate}T00:00:00Z`;
  if (prevTimestamp !== null && prevTimestamp > candidate) return prevTimestamp;
  return candidate;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run tests/chain/seal.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 9: Commit**

```bash
git add src/chain/period.ts src/chain/seal.ts tests/chain/period.test.ts tests/chain/seal.test.ts
git commit -m "feat(chain): add monthly sealing with empty-block minting"
```

---

### Task 7: Chain verification

Implements §7. This module must import only `hash.ts` and `merkle.ts` so the browser can reuse it unchanged.

**Files:**
- Create: `src/chain/verify.ts`
- Test: `tests/chain/verify.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` from `src/chain/hash`, `merkleRootHex` from `src/chain/merkle`, `canonicalBlockHeader` from `src/chain/canonical`, `Chain`/`Block` from `src/chain/types`.
- Produces:
  - `interface BlockVerification { height: number; hashOk: boolean; merkleOk: boolean; linkOk: boolean; powOk: boolean; ok: boolean }`
  - `verifyBlock(block: Block, prev: Block | null, difficulty: number): Promise<BlockVerification>`
  - `verifyChain(chain: Chain): Promise<{ ok: boolean; blocks: BlockVerification[] }>`

- [ ] **Step 1: Write the failing test**

Create `tests/chain/verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyChain } from '../../src/chain/verify';
import { merkleRootHex } from '../../src/chain/merkle';
import { mine } from '../../src/chain/mine';
import type { Block, Chain, Transaction } from '../../src/chain/types';

const DIFFICULTY = 2;
const ZERO = '0x' + '00'.repeat(32);

function tx(slug: string): Transaction {
  return {
    hash: '0x' + slug.repeat(64).slice(0, 64),
    type: 'post',
    slug,
    title: slug,
    date: '2026-07-01',
    tags: [],
    series: null,
    from: '0xaaaa',
    to: [],
    contentHash: ZERO,
    gasUsed: 10,
    value: 1,
    amends: null,
  };
}

async function makeBlock(
  height: number,
  prevHash: string,
  transactions: Transaction[],
): Promise<Block> {
  const merkleRoot = await merkleRootHex(transactions.map((t) => t.hash));
  const header = {
    height,
    prevHash,
    merkleRoot,
    timestamp: `2026-0${height + 1}-01T00:00:00Z`,
    txCount: transactions.length,
    gasUsed: transactions.reduce((s, t) => s + t.gasUsed, 0),
    difficulty: DIFFICULTY,
  };
  const { nonce, hash } = mine(header, DIFFICULTY);
  return {
    ...header,
    nonce,
    hash,
    period: `2026-0${height + 1}`,
    value: transactions.reduce((s, t) => s + t.value, 0),
    transactions,
  };
}

async function validChain(): Promise<Chain> {
  const b0 = await makeBlock(0, ZERO, [tx('a')]);
  const b1 = await makeBlock(1, b0.hash, [tx('b'), tx('c')]);
  return { version: 1, difficulty: DIFFICULTY, blocks: [b0, b1] };
}

describe('verifyChain', () => {
  it('accepts a well-formed chain', async () => {
    const result = await verifyChain(await validChain());
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.every((b) => b.ok)).toBe(true);
  });

  it('accepts an empty block', async () => {
    const b0 = await makeBlock(0, ZERO, []);
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [b0] });
    expect(result.ok).toBe(true);
  });

  it('accepts a chain with no blocks', async () => {
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [] });
    expect(result.ok).toBe(true);
    expect(result.blocks).toEqual([]);
  });

  it('detects a tampered transaction via the merkle root', async () => {
    const chain = await validChain();
    chain.blocks[1]!.transactions[0]!.hash = '0x' + 'f'.repeat(64);
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.merkleOk).toBe(false);
  });

  it('detects a tampered block header via the block hash', async () => {
    const chain = await validChain();
    chain.blocks[0]!.gasUsed = 999999;
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.hashOk).toBe(false);
  });

  it('detects a broken prev-hash link', async () => {
    const chain = await validChain();
    chain.blocks[1]!.prevHash = '0x' + 'e'.repeat(64);
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.linkOk).toBe(false);
  });

  it('requires the genesis block to link to zero', async () => {
    const chain = await validChain();
    chain.blocks[0]!.prevHash = '0x' + '11'.repeat(32);
    const result = await verifyChain(chain);
    expect(result.blocks[0]!.linkOk).toBe(false);
  });

  it('detects a hash that does not meet the stated difficulty', async () => {
    const chain = await validChain();
    const result = await verifyChain({ ...chain, difficulty: 8 });
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.powOk).toBe(false);
  });

  it('detects a non-contiguous height', async () => {
    const chain = await validChain();
    chain.blocks[1]!.height = 5;
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chain/verify.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/verify`.

- [ ] **Step 3: Implement `src/chain/verify.ts`**

```ts
import { canonicalBlockHeader } from './canonical';
import { sha256Hex } from './hash';
import { merkleRootHex } from './merkle';
import type { Block, Chain } from './types';

const ZERO_HASH = '0x' + '00'.repeat(32);

export interface BlockVerification {
  height: number;
  hashOk: boolean;
  merkleOk: boolean;
  linkOk: boolean;
  powOk: boolean;
  ok: boolean;
}

/**
 * §7 — pure verification, imported by both the build and the browser.
 * It must never gain a Node-only dependency.
 */
export async function verifyBlock(
  block: Block,
  prev: Block | null,
  difficulty: number,
): Promise<BlockVerification> {
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
  const powOk = block.hash.startsWith('0x' + '0'.repeat(difficulty));

  return {
    height: block.height,
    hashOk,
    merkleOk,
    linkOk,
    powOk,
    ok: hashOk && merkleOk && linkOk && powOk,
  };
}

export async function verifyChain(
  chain: Chain,
): Promise<{ ok: boolean; blocks: BlockVerification[] }> {
  const blocks: BlockVerification[] = [];
  let prev: Block | null = null;
  for (const block of chain.blocks) {
    blocks.push(await verifyBlock(block, prev, chain.difficulty));
    prev = block;
  }
  return { ok: blocks.every((b) => b.ok), blocks };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/chain/verify.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Guard the browser-safety constraint**

Add to `tests/chain/verify.test.ts`:

```ts
import { readFileSync } from 'node:fs';

describe('browser safety', () => {
  it('verify.ts and its transitive chain deps never import node:crypto', () => {
    for (const file of ['verify.ts', 'hash.ts', 'merkle.ts', 'canonical.ts', 'types.ts']) {
      const source = readFileSync(`src/chain/${file}`, 'utf8');
      expect(source, `${file} must stay browser-safe`).not.toContain('node:');
    }
  });
});
```

Run: `npx vitest run tests/chain/verify.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/chain/verify.ts tests/chain/verify.test.ts
git commit -m "feat(chain): add isomorphic chain verification"
```

---

### Task 8: The lock file

Implements §2. The lock file is the ledger; it must serialize deterministically.

**Files:**
- Create: `src/chain/lock.ts`
- Test: `tests/chain/lock.test.ts`

**Interfaces:**
- Consumes: `Chain` from `src/chain/types`.
- Produces:
  - `EMPTY_CHAIN(difficulty: number): Chain`
  - `serializeChain(chain: Chain): string` — stable key order, 2-space indent, trailing newline
  - `readLock(path: string, difficulty: number): Chain` — returns an empty chain if the file is absent
  - `writeLock(path: string, chain: Chain): void`

- [ ] **Step 1: Write the failing test**

Create `tests/chain/lock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_CHAIN, serializeChain, readLock, writeLock } from '../../src/chain/lock';
import type { Chain } from '../../src/chain/types';

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'chain-')), name);
}

const chain: Chain = { version: 1, difficulty: 5, blocks: [] };

describe('EMPTY_CHAIN', () => {
  it('starts at version 1 with no blocks', () => {
    expect(EMPTY_CHAIN(5)).toEqual({ version: 1, difficulty: 5, blocks: [] });
  });
});

describe('serializeChain', () => {
  it('ends with exactly one trailing newline', () => {
    const out = serializeChain(chain);
    expect(out.endsWith('}\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('is stable across repeated calls', () => {
    expect(serializeChain(chain)).toBe(serializeChain(chain));
  });

  it('does not depend on key insertion order', () => {
    const reordered = { blocks: [], difficulty: 5, version: 1 } as unknown as Chain;
    expect(serializeChain(reordered)).toBe(serializeChain(chain));
  });
});

describe('readLock', () => {
  it('returns an empty chain when the file does not exist', () => {
    expect(readLock(tempFile('missing.json'), 5)).toEqual(EMPTY_CHAIN(5));
  });

  it('round-trips a written chain', () => {
    const path = tempFile('chain.lock.json');
    writeLock(path, chain);
    expect(readLock(path, 5)).toEqual(chain);
  });

  it('throws on malformed JSON rather than silently resetting the ledger', () => {
    const path = tempFile('broken.json');
    writeFileSync(path, '{ not json');
    expect(() => readLock(path, 5)).toThrow();
  });

  it('throws on an unknown version rather than guessing', () => {
    const path = tempFile('future.json');
    writeFileSync(path, JSON.stringify({ version: 99, difficulty: 5, blocks: [] }));
    expect(() => readLock(path, 5)).toThrow(/version/i);
  });
});

describe('writeLock', () => {
  it('writes the serialized form verbatim', () => {
    const path = tempFile('chain.lock.json');
    writeLock(path, chain);
    expect(readFileSync(path, 'utf8')).toBe(serializeChain(chain));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chain/lock.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/lock`.

- [ ] **Step 3: Implement `src/chain/lock.ts`**

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Block, Chain, Transaction } from './types';

export function EMPTY_CHAIN(difficulty: number): Chain {
  return { version: 1, difficulty, blocks: [] };
}

/**
 * Serialize with an explicit key order so the committed ledger produces a
 * clean diff and is byte-stable regardless of object construction order.
 */
function orderedTransaction(t: Transaction) {
  return {
    hash: t.hash,
    type: t.type,
    slug: t.slug,
    title: t.title,
    date: t.date,
    tags: t.tags,
    series: t.series,
    from: t.from,
    to: t.to,
    contentHash: t.contentHash,
    gasUsed: t.gasUsed,
    value: t.value,
    amends: t.amends,
  };
}

function orderedBlock(b: Block) {
  return {
    height: b.height,
    period: b.period,
    prevHash: b.prevHash,
    merkleRoot: b.merkleRoot,
    timestamp: b.timestamp,
    txCount: b.txCount,
    gasUsed: b.gasUsed,
    value: b.value,
    difficulty: b.difficulty,
    nonce: b.nonce,
    hash: b.hash,
    transactions: b.transactions.map(orderedTransaction),
  };
}

export function serializeChain(chain: Chain): string {
  const ordered = {
    version: chain.version,
    difficulty: chain.difficulty,
    blocks: chain.blocks.map(orderedBlock),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

export function readLock(path: string, difficulty: number): Chain {
  if (!existsSync(path)) return EMPTY_CHAIN(difficulty);

  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Never silently reset: the lock file is the ledger.
    throw new Error(`${path} is not valid JSON — refusing to overwrite the ledger`, { cause });
  }

  const chain = parsed as Chain;
  if (chain.version !== 1) {
    throw new Error(`${path} has unsupported chain version ${String(chain.version)}`);
  }
  return chain;
}

export function writeLock(path: string, chain: Chain): void {
  writeFileSync(path, serializeChain(chain), 'utf8');
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/chain/lock.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chain/lock.ts tests/chain/lock.test.ts
git commit -m "feat(chain): add deterministic lock file read and write"
```

---

### Task 9: The build orchestrator and CLI

Implements §3.9 (amendments), §5 (content model), §10 (error handling), §11 (golden-file test). This is the task that ties everything together and produces a working `npm run chain:build`.

**Files:**
- Create: `chain.config.ts`
- Create: `src/chain/post.ts`
- Create: `src/chain/build.ts`
- Create: `scripts/build-chain.ts`
- Create: `content/posts/2026-06-15-genesis.md`
- Create: `tests/fixtures/posts/2026-06-15-first.md`
- Create: `tests/fixtures/posts/2026-06-20-second.md`
- Create: `tests/fixtures/posts/2026-07-05-third.md`
- Test: `tests/chain/post.test.ts`
- Test: `tests/chain/build.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces:
  - `parsePost(filePath: string, raw: string): PostInput`
  - `toTransaction(post: PostInput, authorAddress: Hex): Promise<Transaction>`
  - `buildChain(opts: BuildOptions): Promise<{ chain: Chain; minted: number; amendments: number }>`
  - `interface BuildOptions { postsDir: string; lockPath: string; now: string; config: ChainConfig }`

- [ ] **Step 1: Create `chain.config.ts`**

```ts
export interface ChainConfig {
  difficulty: number;
  maxTxPerBlock: number;
  authorHandle: string;
  authorName: string;
}

export const CHAIN_CONFIG: ChainConfig = {
  difficulty: 5,
  maxTxPerBlock: 4,
  authorHandle: 'lamter',
  authorName: 'lamter.eth',
};
```

- [ ] **Step 2: Write the failing test for post parsing**

Create `tests/chain/post.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePost, toTransaction } from '../../src/chain/post';

const RAW = `---
title: "Mo's Algorithm và cách tối ưu"
date: 2026-07-28
tags: [cp, algorithm]
series: "Ghi chú thuật toán"
research: 12.5
summary: "Tóm tắt ngắn."
---

Khi làm việc với các truy vấn trên đoạn.
`;

describe('parsePost', () => {
  it('extracts and slugifies frontmatter', () => {
    const post = parsePost('content/posts/2026-07-28-mo-algorithm.md', RAW);
    expect(post.slug).toBe('2026-07-28-mo-algorithm');
    expect(post.title).toBe("Mo's Algorithm và cách tối ưu");
    expect(post.date).toBe('2026-07-28');
    expect(post.tags).toEqual(['cp', 'algorithm']);
    expect(post.series).toBe('ghi-chu-thuat-toan');
    expect(post.research).toBe(12.5);
  });

  it('defaults research to 0 when omitted', () => {
    const raw = RAW.replace('research: 12.5\n', '');
    expect(parsePost('a/2026-07-28-x.md', raw).research).toBe(0);
  });

  it('defaults series to null when omitted', () => {
    const raw = RAW.replace('series: "Ghi chú thuật toán"\n', '');
    expect(parsePost('a/2026-07-28-x.md', raw).series).toBeNull();
  });

  it('accepts a date written as an unquoted YAML date', () => {
    expect(parsePost('a/2026-07-28-x.md', RAW).date).toBe('2026-07-28');
  });

  it('fails loudly when title is missing', () => {
    const raw = RAW.replace(/title:.*\n/, '');
    expect(() => parsePost('a/2026-07-28-x.md', raw)).toThrow(/title/);
  });

  it('fails loudly when date is missing', () => {
    const raw = RAW.replace(/date:.*\n/, '');
    expect(() => parsePost('a/2026-07-28-x.md', raw)).toThrow(/date/);
  });

  it('names the offending file in the error', () => {
    const raw = RAW.replace(/title:.*\n/, '');
    expect(() => parsePost('a/2026-07-28-x.md', raw)).toThrow(/2026-07-28-x\.md/);
  });
});

describe('toTransaction', () => {
  it('produces a stable 32-byte hash', async () => {
    const post = parsePost('a/2026-07-28-x.md', RAW);
    const tx = await toTransaction(post, '0xauthor');
    expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await toTransaction(post, '0xauthor')).hash).toBe(tx.hash);
  });

  it('sets gas to the word count and value to the research hours', async () => {
    const post = parsePost('a/2026-07-28-x.md', RAW);
    const tx = await toTransaction(post, '0xauthor');
    expect(tx.gasUsed).toBe(8);
    expect(tx.value).toBe(12.5);
  });

  it('addresses one recipient per tag plus the series', async () => {
    const post = parsePost('a/2026-07-28-x.md', RAW);
    const tx = await toTransaction(post, '0xauthor');
    expect(tx.to).toHaveLength(3);
    expect(new Set(tx.to).size).toBe(3);
  });

  it('changes the hash when the body changes', async () => {
    const a = await toTransaction(parsePost('a/x.md', RAW), '0xauthor');
    const b = await toTransaction(
      parsePost('a/x.md', RAW.replace('đoạn.', 'đoạn!')),
      '0xauthor',
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it('changes the hash when only the research value changes', async () => {
    const a = await toTransaction(parsePost('a/x.md', RAW), '0xauthor');
    const b = await toTransaction(
      parsePost('a/x.md', RAW.replace('research: 12.5', 'research: 13.0')),
      '0xauthor',
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it('ignores trailing-whitespace-only edits', async () => {
    const a = await toTransaction(parsePost('a/x.md', RAW), '0xauthor');
    const b = await toTransaction(
      parsePost('a/x.md', RAW.replace('đoạn.\n', 'đoạn.   \n\n\n')),
      '0xauthor',
    );
    expect(a.hash).toBe(b.hash);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/chain/post.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/post`.

- [ ] **Step 4: Implement `src/chain/post.ts`**

```ts
import { basename } from 'node:path';
import matter from 'gray-matter';
import { slugify, tagAddress } from './address';
import {
  canonicalPostTx,
  normalizeBody,
  wordCount,
} from './canonical';
import { sha256Hex } from './hash';
import type { Hex, PostInput, Transaction } from './types';

function required(value: unknown, field: string, filePath: string): string {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${filePath}: missing required frontmatter field "${field}"`);
  }
  return String(value);
}

/** YAML may parse an unquoted date into a Date; normalize both forms. */
function toDateString(value: unknown, filePath: string): string {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${filePath}: "date" must be YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

export function parsePost(filePath: string, raw: string): PostInput {
  const { data, content } = matter(raw);

  const title = required(data.title, 'title', filePath);
  if (data.date === undefined) {
    throw new Error(`${filePath}: missing required frontmatter field "date"`);
  }
  const date = toDateString(data.date, filePath);

  const tags = Array.isArray(data.tags) ? data.tags.map((t) => slugify(String(t))) : [];
  const series = data.series ? slugify(String(data.series)) : null;
  const research = data.research === undefined ? 0 : Number(data.research);
  if (!Number.isFinite(research) || research < 0) {
    throw new Error(`${filePath}: "research" must be a non-negative number`);
  }

  return {
    slug: basename(filePath).replace(/\.md$/, ''),
    title,
    date,
    tags,
    series,
    research,
    summary: data.summary ? String(data.summary) : '',
    body: content,
  };
}

export async function toTransaction(post: PostInput, from: Hex): Promise<Transaction> {
  const normalized = normalizeBody(post.body);
  const contentHash = await sha256Hex(normalized);

  const hash = await sha256Hex(
    canonicalPostTx({
      title: post.title,
      date: post.date,
      tags: post.tags,
      series: post.series,
      research: post.research,
      from,
      contentHash,
    }),
  );

  const recipients = [...post.tags, ...(post.series ? [post.series] : [])];
  const to = await Promise.all(recipients.map(tagAddress));

  return {
    hash,
    type: 'post',
    slug: post.slug,
    title: post.title,
    date: post.date,
    tags: post.tags,
    series: post.series,
    from,
    to,
    contentHash,
    gasUsed: wordCount(normalized),
    value: post.research,
    amends: null,
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/chain/post.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Create the test fixtures**

`tests/fixtures/posts/2026-06-15-first.md`:

```markdown
---
title: "Bài viết đầu tiên"
date: 2026-06-15
tags: [essay]
research: 2.0
summary: "Khởi đầu."
---

Đây là bài viết đầu tiên trên chuỗi.
```

`tests/fixtures/posts/2026-06-20-second.md`:

```markdown
---
title: "Ghi chú về thuật toán"
date: 2026-06-20
tags: [cp, algorithm]
series: "Ghi chú thuật toán"
research: 12.5
summary: "Ghi chú ngắn."
---

Khi làm việc với các truy vấn trên đoạn, ta thường gặp bài toán đếm số phần tử phân biệt.
```

`tests/fixtures/posts/2026-07-05-third.md`:

```markdown
---
title: "Vì sao tôi bỏ Vim"
date: 2026-07-05
tags: [essay]
summary: "Một suy nghĩ ngắn."
---

Không có giá trị research cho bài này.
```

- [ ] **Step 7: Write the failing test for the orchestrator**

Create `tests/chain/build.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChain } from '../../src/chain/build';
import { verifyChain } from '../../src/chain/verify';
import { serializeChain } from '../../src/chain/lock';

const CONFIG = { difficulty: 2, maxTxPerBlock: 4, authorHandle: 'lamter', authorName: 'lamter.eth' };

function workspace(): { postsDir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chain-build-'));
  const postsDir = join(dir, 'posts');
  cpSync('tests/fixtures/posts', postsDir, { recursive: true });
  return { postsDir, lockPath: join(dir, 'chain.lock.json') };
}

describe('buildChain', () => {
  it('seals past months and mints empty blocks for silent ones', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    expect(chain.blocks.map((b) => b.period)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(chain.blocks[0]!.txCount).toBe(2);
    expect(chain.blocks[1]!.txCount).toBe(1);
    expect(chain.blocks[2]!.txCount).toBe(0);
  });

  it('produces a chain that verifies', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect((await verifyChain(chain)).ok).toBe(true);
  });

  it('starts genesis at height 0 with a zero prev hash', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(chain.blocks[0]!.height).toBe(0);
    expect(chain.blocks[0]!.prevHash).toBe('0x' + '00'.repeat(32));
  });

  it('sums gas and value per block', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(chain.blocks[0]!.value).toBe(14.5);
    expect(chain.blocks[2]!.gasUsed).toBe(0);
  });

  it('is byte-identical when re-run at the same clock', async () => {
    const { postsDir, lockPath } = workspace();
    const first = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const second = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(serializeChain(second.chain)).toBe(serializeChain(first.chain));
    expect(second.minted).toBe(0);
  });

  it('never rewrites a sealed block when the clock advances', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(after.chain.blocks.slice(0, 3)).toEqual(before.chain.blocks);
    expect(after.chain.blocks.map((b) => b.period)).toEqual([
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(after.minted).toBe(2);
  });

  it('emits an amendment when a sealed post is edited', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const originalHash = before.chain.blocks[0]!.transactions[0]!.hash;

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');

    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(after.amendments).toBe(1);

    const amendments = after.chain.blocks.flatMap((b) =>
      b.transactions.filter((t) => t.type === 'amendment'),
    );
    expect(amendments).toHaveLength(1);
    expect(amendments[0]!.amends).toBe(originalHash);
    expect(amendments[0]!.gasUsed).toBe(0);
    expect(amendments[0]!.value).toBe(0);
    expect(amendments[0]!.date).toBe('2026-06-15');
  });

  it('leaves the original transaction untouched after an amendment', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(after.chain.blocks[0]).toEqual(before.chain.blocks[0]);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('does not re-emit an amendment on a subsequent unchanged build', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    const third = await buildChain({ postsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(third.amendments).toBe(0);
  });

  it('does not re-mint an empty block for an already-sealed month', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    const periods = after.chain.blocks.map((b) => b.period);
    expect(new Set(periods).size).toBe(periods.length);
  });

  it('seals a backdated post without duplicating intervening months', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    writeFileSync(
      join(postsDir, '2026-06-01-backdated.md'),
      '---\ntitle: "Bài viết lùi ngày"\ndate: 2026-06-01\ntags: [essay]\n---\n\nMột bài viết thêm sau.\n',
    );

    const after = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(after.chain.blocks.slice(0, 3)).toEqual(before.chain.blocks);
    expect(after.chain.blocks).toHaveLength(4);
    expect(after.chain.blocks[3]!.transactions.map((t) => t.slug)).toEqual(['2026-06-01-backdated']);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('refuses to extend a lock file that fails verification', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const corrupt = JSON.parse(readFileSync(lockPath, 'utf8'));
    corrupt.blocks[0].gasUsed = 999999;
    writeFileSync(lockPath, JSON.stringify(corrupt, null, 2));

    await expect(
      buildChain({ postsDir, lockPath, now: '2026-10-10', config: CONFIG }),
    ).rejects.toThrow(/refusing to extend/);
  });

  it('matches the golden snapshot at a pinned clock', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(serializeChain(chain)).toMatchSnapshot();
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run tests/chain/build.test.ts`
Expected: FAIL — cannot resolve `../../src/chain/build`.

- [ ] **Step 9: Implement `src/chain/build.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainConfig } from '../../chain.config';
import { identityAddress } from './address';
import { canonicalAmendmentTx } from './canonical';
import { sha256Hex } from './hash';
import { readLock, writeLock } from './lock';
import { merkleRootHex } from './merkle';
import { mine } from './mine';
import { parsePost, toTransaction } from './post';
import { blockTimestamp, planBlocks } from './seal';
import type { Block, Chain, Hex, Transaction } from './types';
import { verifyChain } from './verify';

const ZERO_HASH = '0x' + '00'.repeat(32);

export interface BuildOptions {
  postsDir: string;
  lockPath: string;
  /** Injected clock, YYYY-MM-DD. */
  now: string;
  config: ChainConfig;
}

export interface BuildResult {
  chain: Chain;
  /** Blocks sealed by this build. */
  minted: number;
  /** Amendment transactions emitted by this build. */
  amendments: number;
}

function readPostTransactions(postsDir: string, from: Hex): Promise<Transaction[]> {
  const files = readdirSync(postsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return Promise.all(
    files.map((file) => {
      const path = join(postsDir, file);
      return toTransaction(parsePost(path, readFileSync(path, 'utf8')), from);
    }),
  );
}

/**
 * §3.9 — a sealed post whose content hash no longer matches produces an
 * amendment transaction rather than a rewrite. Amendments already recorded in
 * the lock are not re-emitted.
 */
async function detectAmendments(
  sealed: Transaction[],
  current: Transaction[],
  from: Hex,
): Promise<Transaction[]> {
  const currentBySlug = new Map(current.map((t) => [t.slug, t]));
  const alreadyAmended = new Set(
    sealed.filter((t) => t.type === 'amendment').map((t) => `${t.amends}:${t.contentHash}`),
  );

  const out: Transaction[] = [];
  for (const original of sealed) {
    if (original.type === 'amendment') continue;
    const live = currentBySlug.get(original.slug);
    if (!live || live.contentHash === original.contentHash) continue;
    if (alreadyAmended.has(`${original.hash}:${live.contentHash}`)) continue;

    const hash = await sha256Hex(
      canonicalAmendmentTx({
        date: original.date,
        amends: original.hash,
        from,
        contentHash: live.contentHash,
      }),
    );
    out.push({
      hash,
      type: 'amendment',
      slug: null,
      title: null,
      date: original.date,
      tags: [],
      series: null,
      from,
      to: [],
      contentHash: live.contentHash,
      gasUsed: 0,
      value: 0,
      amends: original.hash,
    });
  }
  return out;
}

export async function buildChain(opts: BuildOptions): Promise<BuildResult> {
  const { config } = opts;
  const from = await identityAddress(config.authorHandle);

  const chain = readLock(opts.lockPath, config.difficulty);

  // §10 — the lock is the source of truth. If it is already inconsistent,
  // fail before appending rather than building on top of a broken ledger.
  const existing = await verifyChain(chain);
  if (!existing.ok) {
    const bad = existing.blocks.filter((b) => !b.ok).map((b) => `#${b.height}`);
    throw new Error(
      `${opts.lockPath} failed verification at block ${bad.join(', ')} — refusing to extend a broken chain`,
    );
  }

  const sealedPeriods = new Set(chain.blocks.map((b) => b.period));
  const sealedTxs = chain.blocks.flatMap((b) => b.transactions);
  const sealedHashes = new Set(sealedTxs.map((t) => t.hash));

  const live = await readPostTransactions(opts.postsDir, from);
  const amendments = await detectAmendments(sealedTxs, live, from);

  // Anything not already committed is pending.
  const pending = [...live, ...amendments].filter((t) => !sealedHashes.has(t.hash));

  const lastBlock = chain.blocks.at(-1) ?? null;
  const drafts = planBlocks(pending, {
    fromPeriod: lastBlock ? lastBlock.period : null,
    now: opts.now,
    maxTxPerBlock: config.maxTxPerBlock,
  });

  let prev: Block | null = lastBlock;
  let minted = 0;
  let amendmentsSealed = 0;

  for (const draft of drafts) {
    // planBlocks walks from the last sealed period inclusive, so it re-proposes
    // empty blocks for months already on the chain. Drop those. A draft WITH
    // transactions for an already-sealed period is legitimate — it is the
    // remainder of a size-limit split, or a post backdated into that month.
    if (draft.transactions.length === 0 && sealedPeriods.has(draft.period)) continue;

    const merkleRoot = await merkleRootHex(draft.transactions.map((t) => t.hash));
    const header = {
      height: prev ? prev.height + 1 : 0,
      prevHash: prev ? prev.hash : ZERO_HASH,
      merkleRoot,
      timestamp: blockTimestamp(draft, prev ? prev.timestamp : null),
      txCount: draft.transactions.length,
      gasUsed: draft.transactions.reduce((s, t) => s + t.gasUsed, 0),
      difficulty: config.difficulty,
    };
    const { nonce, hash } = mine(header, config.difficulty);

    const block: Block = {
      ...header,
      nonce,
      hash,
      period: draft.period,
      value: Number(draft.transactions.reduce((s, t) => s + t.value, 0).toFixed(1)),
      transactions: draft.transactions,
    };

    chain.blocks.push(block);
    sealedPeriods.add(block.period);
    prev = block;
    minted++;
    amendmentsSealed += draft.transactions.filter((t) => t.type === 'amendment').length;
  }

  writeLock(opts.lockPath, chain);
  return { chain, minted, amendments: amendmentsSealed };
}
```

- [ ] **Step 10: Run it to verify it passes**

Run: `npx vitest run tests/chain/build.test.ts`
Expected: PASS, 13 tests. A snapshot file is written to `tests/chain/__snapshots__/build.test.ts.snap` — commit it; it is the golden file.

- [ ] **Step 11: Implement the CLI**

Create `scripts/build-chain.ts`:

```ts
import { CHAIN_CONFIG } from '../chain.config';
import { buildChain } from '../src/chain/build';
import { verifyChain } from '../src/chain/verify';

/**
 * The clock enters the system here and nowhere else. `--now=YYYY-MM-DD`
 * overrides it, which is what makes reproducible builds possible.
 */
function resolveNow(argv: string[]): string {
  const flag = argv.find((a) => a.startsWith('--now='));
  if (flag) return flag.slice('--now='.length);
  return new Date().toISOString().slice(0, 10);
}

const now = resolveNow(process.argv.slice(2));

const { chain, minted, amendments } = await buildChain({
  postsDir: 'content/posts',
  lockPath: 'chain.lock.json',
  now,
  config: CHAIN_CONFIG,
});

const result = await verifyChain(chain);
const txCount = chain.blocks.reduce((s, b) => s + b.txCount, 0);

console.log(`  clock       ${now}`);
console.log(`  sealed      ${minted} new block(s)`);
if (amendments > 0) console.log(`  amendments  ${amendments} sealed post(s) edited`);
console.log(`  height      ${chain.blocks.length}`);
console.log(`  txns        ${txCount}`);
console.log(`  integrity   ${result.ok ? 'OK' : 'FAILED'}`);

if (!result.ok) {
  for (const b of result.blocks.filter((b) => !b.ok)) {
    console.error(
      `  block #${b.height}  hash:${b.hashOk} merkle:${b.merkleOk} link:${b.linkOk} pow:${b.powOk}`,
    );
  }
  process.exit(1);
}
```

- [ ] **Step 12: Create the genesis post**

Create `content/posts/2026-06-15-genesis.md`:

```markdown
---
title: "Khối đầu tiên"
date: 2026-06-15
tags: [meta]
research: 1.0
summary: "Bài viết mở đầu cho chuỗi."
---

Đây là giao dịch đầu tiên trên chuỗi này.

Mỗi bài viết là một giao dịch. Mỗi tháng là một khối. Hash, merkle root và
nonce đều được tính thật, và bạn có thể tự kiểm chứng chúng ngay trong trình
duyệt của mình.
```

- [ ] **Step 13: Run the real build**

Run: `npm run chain:build -- --now=2026-08-02`
Expected: mines at difficulty 5 (roughly a second), prints `integrity   OK`, and writes `chain.lock.json`.

Then confirm idempotence:

Run: `npm run chain:build -- --now=2026-08-02`
Expected: `sealed      0 new block(s)`, and `git diff --stat chain.lock.json` reports no change.

- [ ] **Step 14: Run the whole suite**

Run: `npm test`
Expected: PASS across 11 test files, 130 tests.

- [ ] **Step 15: Commit**

```bash
git add chain.config.ts src/chain/post.ts src/chain/build.ts scripts/build-chain.ts \
        content/posts/2026-06-15-genesis.md chain.lock.json \
        tests/fixtures tests/chain/post.test.ts tests/chain/build.test.ts \
        tests/chain/__snapshots__
git commit -m "feat(chain): add build orchestrator, CLI and genesis block"
```

---

## Done criteria

- `npm test` passes.
- `npm run chain:build -- --now=<date>` twice in a row leaves `chain.lock.json` byte-identical.
- Advancing `--now` by two months adds exactly two empty blocks and changes no existing block.
- Editing a sealed post adds an amendment transaction and leaves the original block untouched.
- `verifyChain` returns `ok: true` for the real chain.

## What this plan deliberately does not cover

Plan 2 (the Astro site) and Plan 3 (search island, verifier UI, CI/deploy). This plan ends with a working, tested, committed chain engine and a CLI that produces the ledger those plans will render.
