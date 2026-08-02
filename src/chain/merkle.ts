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
