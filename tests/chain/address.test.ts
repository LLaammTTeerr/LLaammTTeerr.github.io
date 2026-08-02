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
