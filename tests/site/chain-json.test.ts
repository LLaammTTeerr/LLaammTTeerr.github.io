import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, readDist } from './dist';
import { buildSandbox, sandboxRepo, startDevSandbox, type DevServer } from './sandbox';
import { verifyChain } from '../../src/chain/verify';
import type { Chain } from '../../src/chain/types';

/**
 * §7 — `/chain.json` is the ledger itself, published for a reader to recompute.
 *
 * The property under test is **byte identity**, not equivalence: what the site
 * serves must be the committed `chain.lock.json`, character for character. Any
 * route that parsed the file and re-serialised it would pass a `toEqual` on the
 * parsed objects while shipping a document whose key order, spacing or number
 * formatting differed — and a reader who diffed the two would see noise and
 * reasonably conclude the published ledger was not the committed one. Equality
 * is the whole point of publishing it, so every assertion here compares strings.
 *
 * The open block is deliberately *not* in that document, and the sandbox blocks
 * below are what prove it: a pending transaction has a real hash but no mined
 * block, so a merged document is one `verifyChain` must reject. It gets its own
 * route, `/chain.pending.json`, which exists exactly when the repository has an
 * open block to publish.
 *
 * The live repository proves the shipped route; the sandboxes prove the rule
 * holds on a chain this file mined itself, so nothing here depends on what the
 * author happens to have published today.
 */

const LOCK = 'chain.lock.json';
const PENDING = 'chain.pending.json';

/** Transaction hashes recorded in an open block file, or `[]` if there is none. */
function pendingHashes(dir: string): string[] {
  const path = join(dir, PENDING);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { transactions: { hash: string }[] };
  return parsed.transactions.map((t) => t.hash);
}

describe('/chain.json as the site ships it', () => {
  it('serves bytes identical to the committed ledger', () => {
    expect(readDist('chain.json')).toBe(readFileSync(LOCK, 'utf8'));
  });

  it('verifies as a chain, fetched exactly as a browser would get it', async () => {
    // The point of publishing it. If this ever fails, the file a reader checks
    // is not the file the site was built from.
    const served = JSON.parse(readDist('chain.json')) as Chain;
    const result = await verifyChain(served);
    expect(result.ok, JSON.stringify(result.blocks.filter((b) => !b.ok))).toBe(true);

    // `verifyChain({blocks: []})` is `ok`, so the assertion above is only worth
    // something against the blocks the ledger actually holds. Derived from the
    // committed file rather than pinned to a number the author's next post
    // changes.
    const committed = JSON.parse(readFileSync(LOCK, 'utf8')) as Chain;
    expect(committed.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBe(committed.blocks.length);
  });

  it('serves the open block separately, or not at all — never merged in', () => {
    // A pending transaction has a real hash but no mined block. Merging the open
    // block into the ledger would produce a document `verifyChain` must reject,
    // and a reader would reasonably conclude the chain was broken.
    const parsed = JSON.parse(readDist('chain.json')) as Chain;
    expect(parsed.blocks.length).toBeGreaterThan(0);
    for (const block of parsed.blocks) {
      expect(Number.isInteger(block.nonce), `block #${block.height} carries no mined nonce`).toBe(true);
      // And the nonce is one that was actually found: an unmined block could
      // carry `nonce: 0` and satisfy the check above.
      expect(block.hash.slice(2, 2 + block.difficulty), `block #${block.height} is not mined`).toBe(
        '0'.repeat(block.difficulty),
      );
    }

    // Whatever open block the repository currently records, none of it is in
    // there. Vacuous when nothing is pending — the sandbox below is where this
    // rule is proved against a guaranteed open block.
    const served = readDist('chain.json');
    for (const hash of pendingHashes('.')) {
      expect(served, `${hash} is pending and was published as sealed history`).not.toContain(hash);
    }
  });
});

/**
 * A chain this file mined, small enough that byte identity is not carried by
 * the demo corpus happening to be there: two sealed transactions in one block,
 * and one post still open. The fixture posts are 2026-06-15, 2026-06-20 and
 * 2026-07-05, so a clock inside July seals June and leaves July open.
 */
describe('a build with an open block', () => {
  let dir = '';
  let server: DevServer;

  beforeAll(async () => {
    dir = sandboxRepo({ content: 'fixture', chainAt: '2026-07-10' });
    const built = buildSandbox(dir);
    if (built.status !== 0) throw new Error(`the sandbox build failed:\n${built.output}`);
    server = await startDevSandbox(dir);
  }, 600_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('mined a chain with something sealed and something still open', () => {
    // The precondition every assertion below rests on. Without it a pending
    // file that silently stopped being written would make them all pass.
    const lock = JSON.parse(readFileSync(join(dir, LOCK), 'utf8')) as Chain;
    expect(lock.blocks.length).toBeGreaterThan(0);
    expect(pendingHashes(dir).length).toBeGreaterThan(0);
  });

  it('publishes the mined ledger byte for byte', () => {
    expect(readFileSync(join(dir, 'dist/chain.json'), 'utf8')).toBe(
      readFileSync(join(dir, LOCK), 'utf8'),
    );
  });

  it('leaves every pending transaction out of the ledger', async () => {
    const served = readFileSync(join(dir, 'dist/chain.json'), 'utf8');
    const hashes = pendingHashes(dir);
    expect(hashes.length).toBeGreaterThan(0);
    for (const hash of hashes) {
      expect(served, `${hash} has no mined block and was published as sealed history`).not.toContain(
        hash,
      );
    }
    // And what is left standing is a chain, not merely a document with the
    // pending rows deleted out of it.
    const result = await verifyChain(JSON.parse(served) as Chain);
    expect(result.ok, JSON.stringify(result.blocks.filter((b) => !b.ok))).toBe(true);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('publishes the open block at its own route, byte for byte', () => {
    expect(readFileSync(join(dir, 'dist/chain.pending.json'), 'utf8')).toBe(
      readFileSync(join(dir, PENDING), 'utf8'),
    );
  });

  it('publishes an open block a reader can attach to the published tip', () => {
    // The two documents are only useful together if the reader can tell where
    // the open one hangs: its `prevHash` must be the tip of the ledger beside
    // it, which is the check `chain.pending.json` exists to make possible.
    const lock = JSON.parse(readFileSync(join(dir, 'dist/chain.json'), 'utf8')) as Chain;
    const open = JSON.parse(readFileSync(join(dir, 'dist/chain.pending.json'), 'utf8')) as {
      prevHash: string;
      height: number;
    };
    const tip = lock.blocks.reduce((best, b) => (b.height > best.height ? b : best), lock.blocks[0]!);
    expect(open.prevHash).toBe(tip.hash);
    expect(open.height).toBe(tip.height + 1);
  });

  it('serves both documents over http, as json', async () => {
    for (const [route, file] of [
      ['/chain.json', LOCK],
      ['/chain.pending.json', PENDING],
    ] as const) {
      const response = await server.get(route);
      expect(response.status, `dev did not serve ${route}:\n${server.output()}`).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.text()).toBe(readFileSync(join(dir, file), 'utf8'));
    }
  }, 60_000);
});

describe('a build with nothing open', () => {
  let dir = '';

  beforeAll(() => {
    // Every fixture post is in the past at this clock, so `chain:build` seals
    // them all and removes the open-block record.
    dir = sandboxRepo({ content: 'fixture', chainAt: '2026-08-05' });
    const built = buildSandbox(dir);
    if (built.status !== 0) throw new Error(`the sandbox build failed:\n${built.output}`);
  }, 600_000);

  it('recorded no open block', () => {
    expect(existsSync(join(dir, PENDING))).toBe(false);
  });

  it('publishes no open block either', () => {
    // Not an empty file and not a stub document: a reader asking for an open
    // block the chain does not have must be told there is none.
    expect(existsSync(join(dir, 'dist/chain.pending.json'))).toBe(false);
  });

  it('still publishes the ledger byte for byte', () => {
    expect(readFileSync(join(dir, 'dist/chain.json'), 'utf8')).toBe(
      readFileSync(join(dir, LOCK), 'utf8'),
    );
  });
});

describe('the published ledger is a file, not a page', () => {
  it('is not wrapped in a document', () => {
    // `dist/chain.json/index.html` instead of `dist/chain.json` would be the
    // silent failure: the route "works" in dev and serves HTML in production.
    expect(existsSync(join(DIST, 'chain.json'))).toBe(true);
    expect(readDist('chain.json').startsWith('{')).toBe(true);
  });
});
