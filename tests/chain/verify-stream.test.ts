import { describe, it, expect } from 'vitest';
import { verifyChain, verifyChainStream } from '../../src/chain/verify';
import type { BlockVerification } from '../../src/chain/verify';
import type { Block, Chain } from '../../src/chain/types';
import { DIFFICULTY, ZERO, makeBlock, tx, validChain } from './chain-fixture';

/**
 * §7 — the entry point the browser verifier consumes.
 *
 * `verifyChain` answers all at once, which is right for a build and wrong for
 * a tab: a reader would stare at nothing and then be handed a verdict. The
 * stream yields one block at a time — and `verifyChain` is expressed through
 * it, so the tab and the build cannot prove different things.
 */

/** Drain a stream into an array, the way a caller who wants everything would. */
async function collect(chain: unknown): Promise<BlockVerification[]> {
  const out: BlockVerification[] = [];
  for await (const result of verifyChainStream(chain as Chain)) out.push(result);
  return out;
}

describe('verifyChainStream', () => {
  it('yields one result per block, in order', async () => {
    const chain = await validChain();
    const seen = (await collect(chain)).map((r) => r.height);
    expect(seen).toEqual(chain.blocks.map((b) => b.height));
  });

  it('agrees with verifyChain, block for block', async () => {
    // The guarantee that stops the two drifting. If this ever fails, the
    // browser and the build are proving different things.
    const chain = await validChain();
    const streamed = await collect(chain);
    expect(streamed).toEqual((await verifyChain(chain)).blocks);
    expect(streamed.every((r) => r.ok)).toBe(true);
  });

  it('agrees with verifyChain on a broken chain too, failure for failure', async () => {
    // Agreement on a clean chain is the easy half: every field is `true` on
    // both sides, so a stream that hard-coded `ok: true` would pass it. This
    // is the half that fails if the stream ever stops carrying a real verdict
    // — a broken link, a broken proof of work and a forged transaction at
    // once, each of which lands in a different field.
    const chain = await validChain();
    chain.blocks[1]!.prevHash = '0x' + '11'.repeat(32);
    chain.blocks[2]!.nonce += 1;
    chain.blocks[0]!.transactions[0]!.title = 'Đã sửa';
    const streamed = await collect(chain);
    expect(streamed).toEqual((await verifyChain(chain)).blocks);
    expect(streamed.map((r) => r.ok)).toEqual([false, false, false]);
    expect(streamed[0]!.txOk).toBe(false);
    expect(streamed[1]!.linkOk).toBe(false);
    expect(streamed[2]!.hashOk).toBe(false);
  });

  it('yields each block before it has looked at the next one', async () => {
    // What "streaming" actually means, and the only assertion here that can
    // tell a generator from a function that verifies everything and then
    // yields the results one by one. `blocks` is a real array — `Array.isArray`
    // must still hold — whose elements report when they are read.
    const chain = await validChain();
    const read: number[] = [];
    const spied: Block[] = [];
    chain.blocks.forEach((block, i) => {
      Object.defineProperty(spied, i, {
        get: () => {
          read.push(i);
          return block;
        },
        enumerable: true,
        configurable: true,
      });
    });
    expect(Array.isArray(spied)).toBe(true);
    expect(spied).toHaveLength(3);

    const stream = verifyChainStream({ ...chain, blocks: spied });
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect((first.value as BlockVerification).height).toBe(0);
    // Only block #0 has been touched: a batch implementation would have read
    // all three before handing back the first result.
    expect(read).toEqual([0]);

    await stream.next();
    expect(read).toEqual([0, 1]);
    await stream.return(undefined as never);
    expect(read, 'abandoning the stream still verified the rest of the chain').toEqual([0, 1]);
  });

  it('catches a forged title, which a merkle-only check would not', async () => {
    // §7's stated reason for recomputing every transaction hash: "verifying
    // only the Merkle root proves the recorded hashes are consistent with each
    // other, not that they match the content displayed beside them — a forged
    // title would still verify clean."
    //
    // So: change what the page displays, leave every recorded hash untouched.
    const chain = await validChain();
    const forged = chain.blocks[1]!.transactions[0]!;
    const before = { hash: forged.hash, merkleRoot: chain.blocks[1]!.merkleRoot, block: chain.blocks[1]!.hash };
    forged.title = 'Một tiêu đề chưa từng được băm';

    const results = await collect(chain);
    expect(results.some((r) => !r.ok)).toBe(true);

    // Not a single recorded hash was touched, which is exactly why the
    // merkle-only checks stay green — and why `txOk` is the one that catches
    // it. If this block ever reported `merkleOk: false`, the test would be
    // proving something weaker than §7 asks for.
    const block = results[1]!;
    expect(chain.blocks[1]!.transactions[0]!.hash).toBe(before.hash);
    expect(chain.blocks[1]!.merkleRoot).toBe(before.merkleRoot);
    expect(chain.blocks[1]!.hash).toBe(before.block);
    expect(block.merkleOk, 'the recorded hashes still agree with each other').toBe(true);
    expect(block.hashOk, 'the mined header still commits to the same merkle root').toBe(true);
    expect(block.powOk, 'the proof of work is untouched').toBe(true);
    expect(block.txOk, 'the forged title recomputes to a different hash').toBe(false);
    expect(block.ok).toBe(false);
  });

  /**
   * Everything a browser can actually be handed by a network it does not
   * control: a truncated body, a hand-edited document, the wrong file
   * entirely, a JSON scalar. `verifyChainStream` must produce a verdict for
   * each, never an exception — an island that throws leaves the reader with a
   * page stuck mid-check and no verdict at all.
   */
  async function hostileInputs(): Promise<unknown[]> {
    const chain = await validChain();
    const truncatedBlock = structuredClone(chain) as unknown as Record<string, unknown>;
    // What a cut-off response parses to, once the tail of the document is gone.
    delete (((truncatedBlock.blocks as Block[])[2] as unknown) as Record<string, unknown>).nonce;
    delete (((truncatedBlock.blocks as Block[])[2] as unknown) as Record<string, unknown>).hash;
    const truncatedTx = structuredClone(chain);
    truncatedTx.blocks[1]!.transactions = [{ hash: '0x' + '1'.repeat(64) } as never];

    return [
      null,
      undefined,
      0,
      '',
      'not json at all',
      true,
      [],
      {},
      { version: 1 },
      { version: 1, difficulty: 5, blocks: null, assets: [] },
      { version: 1, difficulty: 5, blocks: 'nope', assets: [] },
      { version: 1, difficulty: 5, blocks: [null, undefined, 7, 'x', []], assets: [] },
      { version: 1, difficulty: 5, blocks: [{}], assets: [] },
      { version: 1, difficulty: 'five', blocks: chain.blocks, assets: [] },
      { blocks: [{ ...chain.blocks[0], transactions: null }] },
      { blocks: [{ ...chain.blocks[0], difficulty: -1 }] },
      { blocks: [{ ...chain.blocks[0], difficulty: 999 }] },
      truncatedBlock,
      truncatedTx,
      chain.blocks[0],
    ];
  }

  it('never throws, whatever it is handed', async () => {
    const inputs = await hostileInputs();
    expect(inputs.length).toBeGreaterThan(10);
    for (const junk of inputs) {
      await expect(collect(junk), `threw on ${JSON.stringify(junk)?.slice(0, 60)}`).resolves.toBeDefined();
    }
  });

  it('reports a verdict for hostile input rather than an empty silence', async () => {
    // "Did not throw" is satisfied by a stream that yields nothing at all. A
    // document that *has* blocks must produce one result per block, each
    // failing, so the page shows the reader which block it choked on.
    const results = await collect({ version: 1, difficulty: 5, blocks: [null, {}, 7], assets: [] });
    expect(results).toHaveLength(3);
    expect(results.every((r) => !r.ok)).toBe(true);
    for (const r of results) expect(r.reason).toEqual(expect.any(String));
  });

  it('keeps verifying after a structurally broken block', async () => {
    const chain = await validChain();
    const blocks: unknown[] = [chain.blocks[0], null, chain.blocks[1], chain.blocks[2]];
    const results = await collect({ ...chain, blocks });
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.ok)).toEqual([true, false, true, true]);
  });

  it('returns the registry problem verifyChain reports, so the page can show it', async () => {
    // The stream yields blocks; the asset registry is chain-level, and
    // `/verify` would otherwise be a weaker check than the build's. It arrives
    // as the generator's return value.
    const assetHash = '0x' + '1a'.repeat(32);
    const b0 = await makeBlock(0, ZERO, [await tx('a', [assetHash])]);
    const chain: Chain = {
      version: 1,
      difficulty: DIFFICULTY,
      blocks: [b0],
      assets: [{ tokenId: 7, hash: assetHash, file: 'a.svg', mime: 'image/svg+xml', bytes: 10, mintedIn: 0 }],
    };

    const stream = verifyChainStream(chain);
    let step = await stream.next();
    const blocks: BlockVerification[] = [];
    while (step.done !== true) {
      blocks.push(step.value);
      step = await stream.next();
    }
    expect(blocks.every((b) => b.ok)).toBe(true);
    expect(step.value).toBe((await verifyChain(chain)).registry);
    expect(step.value).toBe('asset #0 has tokenId 7, expected 1');
  });

  it('returns null for a registry that is consistent', async () => {
    const stream = verifyChainStream(await validChain());
    let step = await stream.next();
    while (step.done !== true) step = await stream.next();
    expect(step.value).toBeNull();
    expect((await verifyChain(await validChain())).registry).toBeUndefined();
  });
});

describe('verifyChain, now expressed through the stream', () => {
  it('still answers the shape it always did on a clean chain', async () => {
    const result = await verifyChain(await validChain());
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(3);
    expect(Object.hasOwn(result, 'registry')).toBe(false);
  });

  it('still answers a bare verdict for something that is not a chain', async () => {
    const result = await verifyChain(null as unknown as Chain);
    expect(result).toEqual({ ok: false, blocks: [] });
  });
});
