import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPostContent, getPosts } from '../../src/site/chain-data';
import { normalizeBody } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';

describe('getPostContent', () => {
  it('returns the body for a post on the chain', async () => {
    const slug = getPosts()[0]!.slug!;
    const content = await getPostContent(slug);
    expect(content.slug).toBe(slug);
    expect(content.body.length).toBeGreaterThan(0);
  });

  it('returns the normalized body, exactly the bytes that were hashed', async () => {
    const slug = getPosts()[0]!.slug!;
    const content = await getPostContent(slug);
    expect(await sha256Hex(content.body)).toBe(content.contentHash);
  });

  it('returns a body already normalized — normalizing again is a no-op', async () => {
    const content = await getPostContent(getPosts()[0]!.slug!);
    expect(normalizeBody(content.body)).toBe(content.body);
  });

  it('carries the transaction so a caller need not look it up twice', async () => {
    const tx = getPosts()[0]!;
    const content = await getPostContent(tx.slug!);
    expect(content.tx.hash).toBe(tx.hash);
    expect(content.contentHash).toBe(tx.contentHash);
  });

  it('throws for a slug that is not on the chain', async () => {
    await expect(getPostContent('khong-ton-tai')).rejects.toThrow(/khong-ton-tai/);
  });

  it('throws when the file on disk no longer hashes to the committed value', async () => {
    // The guarantee this module exists for. Copy the real post, alter one
    // character, and confirm the mismatch is refused rather than rendered.
    //
    // "chuỗi" appears first in the frontmatter `summary` field and again in
    // the body — a bare (non-global) replace() hits the frontmatter
    // occurrence first, which doesn't affect contentHash at all. Target
    // "chuỗi này", which only occurs in the body, so this genuinely
    // exercises a body mismatch.
    const slug = getPosts()[0]!.slug!;
    const original = readFileSync(join('content/posts', `${slug}.md`), 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'drift-'));
    const altered = join(dir, `${slug}.md`);
    writeFileSync(altered, original.replace('chuỗi này', 'chuoi này'));

    await expect(getPostContent(slug, dir)).rejects.toThrow(/does not match|committed/i);
  });

  it('names both the file and the two hashes when it refuses', async () => {
    const slug = getPosts()[0]!.slug!;
    const original = readFileSync(join('content/posts', `${slug}.md`), 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'drift2-'));
    writeFileSync(join(dir, `${slug}.md`), original + '\nmột dòng thêm vào.\n');

    await expect(getPostContent(slug, dir)).rejects.toThrow(new RegExp(slug));
    await expect(getPostContent(slug, dir)).rejects.toThrow(/0x[0-9a-f]{8}/);
  });

  it('throws when the file is missing entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    await expect(getPostContent(getPosts()[0]!.slug!, dir)).rejects.toThrow(/not found|ENOENT/i);
  });
});
