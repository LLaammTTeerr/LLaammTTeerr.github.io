import { createHash } from 'node:crypto';

/**
 * Synchronous SHA-256, Node-only. Exists solely because mining performs ~1M
 * hashes per block and awaiting a Promise per attempt is far too slow.
 * Only `mine.ts` may import this module — `hash.ts` is bundled for the browser.
 */
export function sha256SyncHex(data: string): string {
  return '0x' + createHash('sha256').update(data, 'utf8').digest('hex');
}
