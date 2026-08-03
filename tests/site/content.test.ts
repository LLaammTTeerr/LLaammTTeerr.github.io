import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPostContent, getPosts } from '../../src/site/chain-data';
import { normalizeBody } from '../../src/chain/canonical';
import { sha256Hex } from '../../src/chain/hash';

/**
 * The same file with exactly one character of its **body** changed.
 *
 * The last non-whitespace character of a post file is always in the body —
 * frontmatter sits above it — so this cannot silently alter a field
 * `contentHash` does not cover, which is the trap a literal `replace()` fell
 * into here: `chuỗi` appeared first in the frontmatter `summary`, and hitting
 * that occurrence changed nothing the chain commits to. Naming a phrase from
 * one particular post also stopped working the moment that post was no longer
 * `getPosts()[0]`.
 */
function withOneBodyCharacterChanged(raw: string): string {
  const at = raw.trimEnd().length - 1;
  if (at < 0) throw new Error('the post file has no body to alter');
  return raw.slice(0, at) + (raw[at] === 'x' ? 'y' : 'x') + raw.slice(at + 1);
}

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
    // character of its body, and confirm the mismatch is refused rather than
    // rendered. See `withOneBodyCharacterChanged` for why it is not a literal.
    const slug = getPosts()[0]!.slug!;
    const original = readFileSync(join('content/posts', `${slug}.md`), 'utf8');
    const drifted = withOneBodyCharacterChanged(original);
    expect(drifted, 'the drift edit changed nothing').not.toBe(original);
    const dir = mkdtempSync(join(tmpdir(), 'drift-'));
    writeFileSync(join(dir, `${slug}.md`), drifted);

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
