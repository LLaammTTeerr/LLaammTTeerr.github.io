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
