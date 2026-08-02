import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeTypeFor, referencedAssets, hashAssetFile } from '../../src/chain/asset';
import { sha256Hex } from '../../src/chain/hash';

describe('mimeTypeFor', () => {
  it('maps the formats a post is likely to embed', () => {
    expect(mimeTypeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeTypeFor('a.png')).toBe('image/png');
    expect(mimeTypeFor('a.jpg')).toBe('image/jpeg');
    expect(mimeTypeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('a.pdf')).toBe('application/pdf');
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeTypeFor('DIAGRAM.PNG')).toBe('image/png');
  });

  it('falls back rather than guessing', () => {
    expect(mimeTypeFor('a.xyz')).toBe('application/octet-stream');
    expect(mimeTypeFor('noextension')).toBe('application/octet-stream');
  });
});

describe('referencedAssets', () => {
  it('finds a markdown image', () => {
    expect(referencedAssets('![sơ đồ](/assets/mo-blocks.svg)')).toEqual(['mo-blocks.svg']);
  });

  it('finds a markdown link', () => {
    expect(referencedAssets('[tải về](/assets/de-bai.pdf)')).toEqual(['de-bai.pdf']);
  });

  it('finds an html img tag', () => {
    expect(referencedAssets('<img src="/assets/chart.png" alt="x">')).toEqual(['chart.png']);
  });

  it('accepts a markdown image with a title', () => {
    expect(referencedAssets('![a](/assets/x.svg "tiêu đề")')).toEqual(['x.svg']);
  });

  it('dedupes repeated references, keeping first-appearance order', () => {
    const body = '![a](/assets/b.svg)\n![c](/assets/a.svg)\n![d](/assets/b.svg)';
    expect(referencedAssets(body)).toEqual(['b.svg', 'a.svg']);
  });

  it('ignores a bare mention that is not a link or an image', () => {
    expect(referencedAssets('the file lives at /assets/x.svg in the repo')).toEqual([]);
  });

  it('ignores an external url', () => {
    expect(referencedAssets('![a](https://example.com/assets/x.svg)')).toEqual([]);
  });

  it('returns an empty array for a body with no assets', () => {
    expect(referencedAssets('chỉ là văn bản thường.')).toEqual([]);
  });
});

describe('hashAssetFile', () => {
  function tempAssets(): string {
    return mkdtempSync(join(tmpdir(), 'assets-'));
  }

  it('hashes the raw bytes, not a normalized string', async () => {
    const dir = tempAssets();
    // Trailing whitespace and CRLF must survive: assets are binary.
    const contents = 'a\r\n  \r\n';
    writeFileSync(join(dir, 'x.svg'), contents);
    const asset = await hashAssetFile(dir, 'x.svg', 'post.md');
    expect(asset.hash).toBe(await sha256Hex(contents));
  });

  it('reports file, mime and byte size', async () => {
    const dir = tempAssets();
    writeFileSync(join(dir, 'chart.png'), 'abcde');
    const asset = await hashAssetFile(dir, 'chart.png', 'post.md');
    expect(asset.file).toBe('chart.png');
    expect(asset.mime).toBe('image/png');
    expect(asset.bytes).toBe(5);
  });

  it('is deterministic', async () => {
    const dir = tempAssets();
    writeFileSync(join(dir, 'x.svg'), 'same');
    expect((await hashAssetFile(dir, 'x.svg', 'p.md')).hash)
      .toBe((await hashAssetFile(dir, 'x.svg', 'p.md')).hash);
  });

  it('fails loudly when the referenced file is missing, naming the post', async () => {
    const dir = tempAssets();
    await expect(hashAssetFile(dir, 'gone.svg', 'content/posts/2026-08-05-x.md'))
      .rejects.toThrow(/2026-08-05-x\.md.*gone\.svg/s);
  });

  it('rejects a file argument that could escape the assets directory', async () => {
    const dir = tempAssets();
    await expect(hashAssetFile(dir, '../secret.env', 'p.md')).rejects.toThrow(/\.\./);
    await expect(hashAssetFile(dir, 'a/../../etc/passwd', 'p.md')).rejects.toThrow(/\.\./);
    await expect(hashAssetFile(dir, 'sub/x.svg', 'p.md')).rejects.toThrow(/\//);
    await expect(hashAssetFile(dir, 'sub\\x.svg', 'p.md')).rejects.toThrow(/\\/);
  });

  it('rejects a lone "." or ".." basename rather than reaching readFileSync on a directory', async () => {
    // `referencedAssets`' capture group (`[A-Za-z0-9._-]+`) permits `.` and
    // `..` as full matches — `![x](/assets/..)` captures exactly `..` — so
    // this is a reachable path, not a hypothetical one. A lone `.` used to
    // slip past every check here, reach `readFileSync` on `assetsDir`
    // itself, and throw a bare EISDIR naming no post.
    const dir = tempAssets();
    await expect(hashAssetFile(dir, '.', 'p.md')).rejects.toThrow(/invalid asset filename "\."/);
    await expect(hashAssetFile(dir, '..', 'p.md')).rejects.toThrow(/invalid asset filename "\.\."/);
  });
});
