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
