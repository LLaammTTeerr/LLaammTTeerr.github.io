import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { sha256Hex } from './hash';
import type { Hex } from './types';

/**
 * §3.2b — assets are files a post references. This module reads the
 * filesystem and is therefore BUILD-TIME ONLY: `verify.ts` must never import
 * it, or the browser bundle breaks.
 */

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};

export function mimeTypeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Every `/assets/<file>` a post links or embeds, in first-appearance order,
 * deduped. Matching requires markdown-link or `<img src>` context, so a bare
 * mention of a path in prose or a code sample is not a reference.
 */
export function referencedAssets(body: string): string[] {
  const out: string[] = [];
  const add = (file: string): void => {
    if (!out.includes(file)) out.push(file);
  };

  const patterns = [
    /\]\(\s*\/assets\/([A-Za-z0-9._-]+)/g,
    /<img\b[^>]*\bsrc=["']\/assets\/([A-Za-z0-9._-]+)["']/g,
  ];

  // Collect with positions so the merged result keeps document order.
  const found: Array<{ at: number; file: string }> = [];
  for (const re of patterns) {
    for (const m of body.matchAll(re)) {
      found.push({ at: m.index ?? 0, file: m[1]! });
    }
  }
  found.sort((a, b) => a.at - b.at);
  for (const f of found) add(f.file);
  return out;
}

export interface AssetFile {
  file: string;
  hash: Hex;
  mime: string;
  bytes: number;
}

/**
 * Hash an asset over its RAW BYTES. Assets are binary; the text
 * normalization applied to post bodies would corrupt them.
 */
export async function hashAssetFile(
  assetsDir: string,
  file: string,
  referencedBy: string,
): Promise<AssetFile> {
  const path = join(assetsDir, file);
  if (!existsSync(path)) {
    throw new Error(
      `${referencedBy}: references /assets/${file}, which does not exist in ${assetsDir}`,
    );
  }
  const buf = readFileSync(path);
  return {
    file,
    hash: await sha256Hex(new Uint8Array(buf)),
    mime: mimeTypeFor(file),
    bytes: buf.byteLength,
  };
}
