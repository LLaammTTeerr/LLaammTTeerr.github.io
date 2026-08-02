import { createHash } from 'node:crypto';
import type { Hex } from './types';

/**
 * The same digest `sha256Hex` produces, computed synchronously.
 *
 * **Node only, and deliberately outside `verify.ts`'s import closure.** That
 * closure ships to the browser (§7) and must never reach a Node built-in;
 * nothing in it imports this file, and `tests/chain/verify.test.ts` pins the
 * closure so it cannot start to.
 *
 * It exists because two readers on the Node side must re-derive a hash from
 * inside synchronous code — `readPending`, which is read from synchronous
 * template code, and `getPendingBlock`, which re-derives a recorded word count
 * from the body on disk. WebCrypto's `digest` is async, and making either path
 * async would rewrite every caller for no gain in what is proved.
 *
 * Only the *hashing* is duplicated, never a canonical form: both callers hash a
 * string built by `canonical.ts`. The two hashers are pinned against each other
 * in `tests/chain/pending.test.ts`, whose fixtures compute their hashes with
 * `sha256Hex` and are then accepted — or rejected — by this one.
 */
export function sha256HexSync(data: string): Hex {
  return '0x' + createHash('sha256').update(data, 'utf8').digest('hex');
}
