import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { verifyChain } from '../../src/chain/verify';
import { canonicalAmendmentTx, canonicalPostTx } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';
import { merkleRootHex } from '../../src/chain/merkle';
import { mine } from '../../src/chain/mine';
import type { Block, Chain, Transaction } from '../../src/chain/types';

const DIFFICULTY = 2;
const ZERO = '0x' + '00'.repeat(32);
/** A well-formed 20-byte address, so fixtures pass the R1 shape check. */
const FROM = '0x' + 'aa'.repeat(20);

/** A post transaction whose hash genuinely commits to its own fields. */
async function tx(slug: string): Promise<Transaction> {
  const fields = {
    title: slug,
    date: '2026-07-01',
    tags: [],
    series: null,
    research: 1,
    from: FROM,
    contentHash: ZERO,
    assets: [],
  };
  return {
    hash: await sha256Hex(canonicalPostTx(fields)),
    type: 'post',
    slug,
    title: fields.title,
    date: fields.date,
    tags: fields.tags,
    series: fields.series,
    from: fields.from,
    to: [],
    contentHash: fields.contentHash,
    assets: fields.assets,
    gasUsed: 10,
    value: fields.research,
    research: null,
    amends: null,
  };
}

async function amendmentTx(amends: string, title: string): Promise<Transaction> {
  const fields = {
    amends,
    date: '2026-07-01',
    title,
    tags: ['cp'],
    series: null,
    research: 3.5,
    from: FROM,
    contentHash: ZERO,
    assets: [],
  };
  return {
    hash: await sha256Hex(canonicalAmendmentTx(fields)),
    type: 'amendment',
    slug: null,
    title: fields.title,
    date: fields.date,
    tags: fields.tags,
    series: fields.series,
    from: fields.from,
    to: [],
    contentHash: fields.contentHash,
    assets: fields.assets,
    gasUsed: 0,
    value: 0,
    research: fields.research,
    amends,
  };
}

async function makeBlock(
  height: number,
  prevHash: string,
  transactions: Transaction[],
  difficulty = DIFFICULTY,
): Promise<Block> {
  const merkleRoot = await merkleRootHex(transactions.map((t) => t.hash));
  const header = {
    height,
    prevHash,
    merkleRoot,
    timestamp: `2026-0${height + 1}-01T00:00:00Z`,
    txCount: transactions.length,
    gasUsed: transactions.reduce((s, t) => s + t.gasUsed, 0),
    difficulty,
  };
  const { nonce, hash } = mine(header, difficulty);
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
  const b0 = await makeBlock(0, ZERO, [await tx('a')]);
  const b1 = await makeBlock(1, b0.hash, [await tx('b'), await tx('c')]);
  return { version: 1, difficulty: DIFFICULTY, blocks: [b0, b1], assets: [] };
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
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [b0], assets: [] });
    expect(result.ok).toBe(true);
  });

  it('accepts a chain with no blocks', async () => {
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [], assets: [] });
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
    expect(result.ok).toBe(false);
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
    expect(result.blocks[1]!.linkOk).toBe(false);
  });

  it('detects a spliced-out block while the survivor header stays valid', async () => {
    const b0 = await makeBlock(0, ZERO, [await tx('a')]);
    const b1 = await makeBlock(1, b0.hash, [await tx('b')]);
    const b2 = await makeBlock(2, b1.hash, [await tx('c')]);

    // Delete the middle block. b2's own header is untouched and still hashes
    // correctly — only its linkage to a parent is now wrong.
    const spliced = { version: 1 as const, difficulty: DIFFICULTY, blocks: [b0, b2], assets: [] };
    const result = await verifyChain(spliced);

    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.linkOk).toBe(false);
    expect(result.blocks[1]!.hashOk).toBe(true);
    expect(result.blocks[1]!.merkleOk).toBe(true);
  });
});

describe('transaction verification', () => {
  it('detects a forged title while every other flag stays true', async () => {
    // The Merkle root only proves the recorded hashes, so a title rewritten in
    // place used to verify clean — the worst possible outcome for a page whose
    // whole purpose is telling readers the chain is honest.
    const chain = await validChain();
    chain.blocks[1]!.transactions[0]!.title = 'HACKED';

    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    const block = result.blocks[1]!;
    expect(block.txOk).toBe(false);
    expect(block.hashOk).toBe(true);
    expect(block.merkleOk).toBe(true);
    expect(block.linkOk).toBe(true);
    expect(block.powOk).toBe(true);
  });

  it('detects a forged research value', async () => {
    const chain = await validChain();
    chain.blocks[1]!.transactions[0]!.value = 999;

    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.txOk).toBe(false);
    expect(result.blocks[1]!.merkleOk).toBe(true);
  });

  it('detects a block gas total that disagrees with its transactions', async () => {
    // gasUsed is derived, so it is not part of a transaction's canonical form:
    // the tx hash and the Merkle root both still check out, and only the
    // block-level aggregate catches this.
    const chain = await validChain();
    chain.blocks[0]!.transactions[0]!.gasUsed = 5;

    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.txOk).toBe(false);
    expect(result.blocks[0]!.hashOk).toBe(true);
    expect(result.blocks[0]!.merkleOk).toBe(true);
  });

  it('detects a block value total that disagrees with its transactions', async () => {
    const chain = await validChain();
    chain.blocks[0]!.value = 42;
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.txOk).toBe(false);
  });

  it('accepts and re-hashes an amendment transaction', async () => {
    const post = await tx('a');
    const b0 = await makeBlock(0, ZERO, [post]);
    const b1 = await makeBlock(1, b0.hash, [await amendmentTx(post.hash, 'Tiêu đề mới')]);
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [b0, b1], assets: [] });
    expect(result.ok).toBe(true);
  });

  it('detects a forged amendment title', async () => {
    const post = await tx('a');
    const b0 = await makeBlock(0, ZERO, [post]);
    const b1 = await makeBlock(1, b0.hash, [await amendmentTx(post.hash, 'Tiêu đề mới')]);
    b1.transactions[0]!.title = 'HACKED';
    const result = await verifyChain({ version: 1, difficulty: DIFFICULTY, blocks: [b0, b1], assets: [] });
    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.txOk).toBe(false);
  });
});

describe('difficulty', () => {
  it('accepts a chain whose blocks were mined at different difficulties', async () => {
    // §3.6 — difficulty is configurable and a change affects only new blocks.
    // Proof of work is checked against the target each block committed to.
    const b0 = await makeBlock(0, ZERO, [await tx('a')], 1);
    const b1 = await makeBlock(1, b0.hash, [await tx('b')], 3);
    const result = await verifyChain({ version: 1, difficulty: 1, blocks: [b0, b1], assets: [] });
    expect(result.ok).toBe(true);
    expect(result.blocks.every((b) => b.powOk)).toBe(true);
  });

  it('rejects a block mined below the chain floor', async () => {
    const b0 = await makeBlock(0, ZERO, [await tx('a')], 1);
    const result = await verifyChain({ version: 1, difficulty: 2, blocks: [b0], assets: [] });
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.powOk).toBe(false);
    expect(result.blocks[0]!.hashOk).toBe(true);
  });

  it('rejects a block whose hash does not meet its own committed difficulty', async () => {
    const b0 = await makeBlock(0, ZERO, [await tx('a')], 1);
    // Claim difficulty 3 in the header and re-derive nothing: the recorded
    // hash no longer has enough leading zeros for what it claims.
    const forged = { ...b0, difficulty: 3 };
    const result = await verifyChain({ version: 1, difficulty: 1, blocks: [forged], assets: [] });
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.powOk).toBe(false);
  });
});

describe('structurally invalid input', () => {
  it('reports a block with no transactions array instead of throwing', async () => {
    const chain = await validChain();
    delete (chain.blocks[0] as unknown as { transactions?: unknown }).transactions;

    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transactions/);
    expect(result.blocks[0]!.ok).toBe(false);
  });

  it('reports a block that is not an object at all', async () => {
    const result = await verifyChain({
      version: 1,
      difficulty: DIFFICULTY,
      blocks: [null as unknown as Block],
      assets: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/not an object/);
  });

  it('reports a transaction with a missing field instead of throwing', async () => {
    const chain = await validChain();
    delete (chain.blocks[0]!.transactions[0] as unknown as { hash?: unknown }).hash;
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*hash/);
  });

  it('does not blow up on an absurd difficulty', async () => {
    const chain = await validChain();
    chain.blocks[0]!.difficulty = 1e9;
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/difficulty/);
  });

  it('reports a chain whose blocks are not an array', async () => {
    const result = await verifyChain({
      version: 1,
      difficulty: DIFFICULTY,
      blocks: 'nope' as unknown as Block[],
      assets: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blocks).toEqual([]);
  });

  it('reports an odd-length transaction hash instead of throwing (R1 path A)', async () => {
    // `merkleRootHex` -> `fromHex` throws on an odd number of hex digits.
    // Truncating a hash by one nibble used to crash the verifier instead of
    // reporting it.
    const chain = await validChain();
    chain.blocks[0]!.transactions[0]!.hash = '0x' + 'a'.repeat(63);
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*hash/);
  });

  it('reports a non-hex transaction hash instead of throwing', async () => {
    const chain = await validChain();
    chain.blocks[0]!.transactions[0]!.hash = '0x' + 'z'.repeat(64);
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*hash/);
  });

  it('reports a malformed "from" address instead of throwing', async () => {
    const chain = await validChain();
    chain.blocks[0]!.transactions[0]!.from = '0xnotanaddress';
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*from/);
  });

  it('reports a numeric "assets" instead of throwing', async () => {
    const chain = await validChain();
    (chain.blocks[0]!.transactions[0] as unknown as { assets: unknown }).assets = 5;
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*assets/);
  });

  it('reports a null "assets" instead of throwing', async () => {
    const chain = await validChain();
    (chain.blocks[0]!.transactions[0] as unknown as { assets: unknown }).assets = null;
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*assets/);
  });

  it('reports an object "assets" instead of throwing', async () => {
    const chain = await validChain();
    (chain.blocks[0]!.transactions[0] as unknown as { assets: unknown }).assets = { a: 1 };
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*assets/);
  });

  it('reports an "assets" array containing a malformed hash', async () => {
    const chain = await validChain();
    chain.blocks[0]!.transactions[0]!.assets = ['0xzz'];
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*asset hash/);
  });

  it('reports an "assets" array containing a truncated hash', async () => {
    const chain = await validChain();
    chain.blocks[0]!.transactions[0]!.assets = ['0x' + 'a'.repeat(63)];
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*asset hash/);
  });

  it('accepts a string "assets" without throwing, but still reports it invalid', async () => {
    // Spreading a string does not throw the way spreading a number or object
    // does — `[...'nope']` yields characters — so this path is safe today only
    // by accident. The array check must catch it deliberately rather than
    // relying on that accident.
    const chain = await validChain();
    (chain.blocks[0]!.transactions[0] as unknown as { assets: unknown }).assets = 'nope';
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[0]!.reason).toMatch(/transaction #0.*assets/);
  });

  it('reports an amendment with a deleted "research" key instead of throwing (R1 path B)', async () => {
    // The structural check permits `research` to be `undefined` (an amendment
    // read from a hand-edited ledger with the key deleted), but
    // `expectedTxHash` used to guard only `=== null`, so `formatResearch`
    // received `undefined` and threw inside `.toFixed`.
    const post = await tx('a');
    const b0 = await makeBlock(0, ZERO, [post]);
    const b1 = await makeBlock(1, b0.hash, [await amendmentTx(post.hash, 'Tiêu đề mới')]);
    delete (b1.transactions[0] as unknown as { research?: unknown }).research;

    const chain = { version: 1 as const, difficulty: DIFFICULTY, blocks: [b0, b1], assets: [] };
    await expect(verifyChain(chain)).resolves.toBeDefined();
    const result = await verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result.blocks[1]!.txOk).toBe(false);
  });
});

/**
 * Every module specifier a source file imports, however it spells it:
 * single or double quoted, `import`/`export ... from`, side-effect `import 'x'`,
 * dynamic `import('x')`, and imports broken across lines.
 */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  // The lookbehind keeps a string literal that merely contains the word —
  // `['date', 'from', 'contentHash']` — from reading as an import of ", ".
  for (const m of source.matchAll(/(?<!['"])\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of source.matchAll(/(?<!['"])\bimport\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  for (const m of source.matchAll(/(?<!['"])\bimport\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

/** A specifier the browser bundle can resolve inside this directory. */
function isSameDirRelative(specifier: string): boolean {
  return /^\.\/[\w.-]+$/.test(specifier);
}

/** Transitively resolve the same-directory imports reachable from an entry module. */
function browserSafeClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(`src/chain/${file}`, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (isSameDirRelative(specifier)) stack.push(`${specifier.slice(2)}.ts`);
    }
  }
  return [...seen].sort();
}

describe('browser safety', () => {
  it('reaches the expected module closure from verify.ts', () => {
    // Pins the closure itself. If a new module joins it, this fails loudly
    // and forces a deliberate decision rather than silently going unchecked.
    expect(browserSafeClosure('verify.ts')).toEqual([
      'canonical.ts', 'hash.ts', 'merkle.ts', 'types.ts', 'verify.ts',
    ]);
  });

  it('every import in the closure is a same-directory relative specifier', () => {
    // Asserting only the absence of "node:" was not enough: `import matter
    // from 'gray-matter'` is a Node-only package with no `node:` anywhere in
    // it, and `from "../foo"` leaves the audited directory entirely. Anything
    // that is not `./sibling` breaks the bundle or the invariant, so require
    // the whole set positively rather than blacklisting one spelling.
    const closure = browserSafeClosure('verify.ts');
    // Guard against a broken walk vacuously passing.
    expect(closure.length).toBeGreaterThanOrEqual(5);
    for (const file of closure) {
      const source = readFileSync(`src/chain/${file}`, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        expect(
          isSameDirRelative(specifier),
          `${file} imports "${specifier}" — the verify.ts closure ships to browsers`,
        ).toBe(true);
      }
      // The positive check above only catches `import`/`export ... from`
      // specifiers. It would not catch `require('node:fs')` or a string built
      // at runtime, so keep this substring check as a second, cheaper net.
      expect(source, `${file} must stay browser-safe`).not.toContain('node:');
    }
  });
});

describe('the browser-safety guard itself', () => {
  it('extracts specifiers in every import spelling', () => {
    const source = [
      "import { a } from './a';",
      'import b from "./b";',
      'import {',
      '  c,',
      "} from './c';",
      "export { d } from './d';",
      "import './side-effect';",
      "const e = await import('./e');",
      "import matter from 'gray-matter';",
      'import { readFileSync } from "node:fs";',
      "import { up } from '../up';",
      "const fields = ['date', 'from', 'contentHash'];",
    ].join('\n');

    expect(importSpecifiers(source).sort()).toEqual([
      '../up',
      './a',
      './b',
      './c',
      './d',
      './e',
      './side-effect',
      'gray-matter',
      'node:fs',
    ]);
  });

  it('rejects bare, parent-directory and node: specifiers', () => {
    expect(isSameDirRelative('./hash')).toBe(true);
    expect(isSameDirRelative('./hash.node')).toBe(true);
    expect(isSameDirRelative('gray-matter')).toBe(false);
    expect(isSameDirRelative('node:crypto')).toBe(false);
    expect(isSameDirRelative('../up')).toBe(false);
    expect(isSameDirRelative('./nested/deep')).toBe(false);
  });
});
