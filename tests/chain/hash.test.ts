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
