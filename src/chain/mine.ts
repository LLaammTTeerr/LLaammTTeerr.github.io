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
  // A negative or fractional target otherwise fails deep inside
  // `meetsDifficulty` as a RangeError from `'0'.repeat(...)`, naming nothing.
  if (!Number.isInteger(difficulty) || difficulty < 0) {
    throw new Error(`difficulty must be a non-negative integer, got ${difficulty}`);
  }

  for (let nonce = 0; ; nonce++) {
    const hash = sha256SyncHex(canonicalBlockHeader({ ...header, nonce }));
    if (meetsDifficulty(hash, difficulty)) return { nonce, hash };
  }
}
