import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mimeTypeFor } from '../chain/asset';
import { sha256Hex } from '../chain/hash';
import type { AssetRecord, Hex } from '../chain/types';
import { getAssets, getChain, getPendingBlock, type RecordedTx } from './chain-data';

/**
 * §3.2b — the asset registry as the site may describe it.
 *
 * An asset exists for **integrity, not theme**: without it, verifying a post
 * proves its text is untampered while its diagrams are unchecked, and someone
 * could swap a published figure with `/verify` still reporting a clean chain.
 * So everything here is a fact the chain commits to, or a value re-derived from
 * one. §3.2b names what is deliberately absent — transfer history, price,
 * rarity, editions, a marketplace — and there is no field below that could
 * carry any of them.
 *
 * Three of `AssetRecord`'s six fields are **not covered by any hash**, and
 * `registryProblem` (src/chain/verify.ts) says so outright: `file`, `mime` and
 * `bytes` are shape-checked on read and authenticated nowhere. `tokenId`,
 * `hash` and `mintedIn` are checked against first appearance in the sealed
 * transactions, so those three are as trustworthy as the blocks themselves.
 * That split is the whole design of this module:
 *
 *  - `bytes` is never displayed. `bytesOnDisk` is measured from a file that
 *    hashes to the token, or is `null`. This is the rule `gasUsed` is already
 *    under (see `derivedGas` in chain-data.ts): a number that cannot be
 *    re-derived is not a number this site may print.
 *  - `file` is never trusted to identify the token. The file at that path is
 *    hashed, and only a match makes the token `current`. After an image swap
 *    two records share one `file`, and a page reading the field would show the
 *    new image beside the old hash and stamp it verified.
 *  - `mime` is re-derived from the filename of the file that matched
 *    (`assetMime`), and is absent when nothing matched.
 *
 * Reads no clock (§14), like everything else under `src/site/`: the registry
 * plus the bytes on disk decide every page, so the same repository builds the
 * same site on any day.
 */

const ASSETS_DIR = 'content/assets';

export interface AssetView extends AssetRecord {
  /**
   * Every transaction whose `assets` contains this hash, in chain order —
   * sealed blocks by ascending height, then the open block. First-appearance
   * order, so `referencedBy[0]` is the transaction that minted the token and
   * its `from` is the minter.
   *
   * `RecordedTx` rather than `Transaction`, which is what the task brief named:
   * a post in the *open* block can reference an already-minted asset (an author
   * reusing a diagram), and it is on the chain (§3.6). Listing sealed
   * transactions only would leave the token page describing a state the chain
   * has already moved past — the exact defect shape this plan keeps finding.
   * A `RecordedTx`'s `gasUsed` may be `null`; nothing here prints one.
   */
  referencedBy: RecordedTx[];
  /** False when the file on disk no longer hashes to this token — a later mint superseded it. */
  current: boolean;
  /**
   * Re-derived from the file on disk; `null` when no file at the recorded path
   * hashes to this token — whether because it is missing, or because it is now
   * a different image. Never the recorded value, which no hash covers.
   */
  bytesOnDisk: number | null;
}

/**
 * `file` is not covered by any hash, and this module turns it into a
 * filesystem read. `assetRecordProblem` already rejects anything but a plain
 * filename when the lock is read, so this is defence in depth on the one path
 * that could follow a tampered ledger off the assets directory — the same
 * guard, and the same reasoning, as `hashAssetFile`'s.
 */
function isPlainFilename(file: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(file) && file !== '.' && file !== '..'
  );
}

/**
 * The bytes at `assetsDir/<record.file>`, but only if they hash to the token.
 * `null` otherwise — the file is missing, unreadable, or is now some other
 * image that merely occupies the name this token was minted under.
 */
async function committedBytes(assetsDir: string, rec: AssetRecord): Promise<Uint8Array | null> {
  if (!isPlainFilename(rec.file)) return null;
  const path = join(assetsDir, rec.file);
  if (!existsSync(path)) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    // A directory sitting where the file should be, or an unreadable one. The
    // token is simply not on disk; that is not a reason to fail the build.
    return null;
  }
  const bytes = new Uint8Array(buf);
  // Raw bytes, no normalization — an asset is binary, not text (§3.2b).
  return (await sha256Hex(bytes)) === rec.hash ? bytes : null;
}

/**
 * The view of a registry, given the transactions that may reference it and the
 * directory the files live in. Newest token first.
 *
 * Takes all three as arguments so the two things this module has to be right
 * about — which token a file currently is, and which transactions reference it
 * — can be driven from fixtures. The live registry is empty and will stay that
 * way until the author publishes an image, so a test that reached for it would
 * pass vacuously forever.
 */
export async function assetViews(
  records: readonly AssetRecord[],
  transactions: readonly RecordedTx[],
  assetsDir: string,
): Promise<AssetView[]> {
  const views = await Promise.all(
    records.map(async (rec): Promise<AssetView> => {
      const bytes = await committedBytes(assetsDir, rec);
      return {
        ...rec,
        referencedBy: transactions.filter((t) => t.assets.includes(rec.hash)),
        current: bytes !== null,
        bytesOnDisk: bytes === null ? null : bytes.byteLength,
      };
    }),
  );
  // Newest first, the order the chain reads in (§9). `tokenId` is assigned by
  // first appearance and verified against it, so this is a total order.
  return views.sort((a, b) => b.tokenId - a.tokenId);
}

/**
 * Every transaction on the chain in first-appearance order: sealed blocks by
 * ascending height, then the open block.
 *
 * Sorted by height rather than trusting the lock's array order, for the reason
 * `tipHash` and `latestAmendment` in chain-data.ts both give: nothing
 * guarantees `chain.blocks` is height-ordered, and the minter is read off the
 * first element of this list.
 *
 * Amendments are included. §3.9 keeps an amendment's `to` empty so the address
 * graph reflects original publication, but `assets` is a different field: an
 * amendment that adds a diagram genuinely references it, and is genuinely what
 * mints it — `registryProblem` computes first appearance over every
 * transaction, amendments included, so a list that dropped them could disagree
 * with the `mintedIn` printed beside it.
 */
function chainTransactions(): RecordedTx[] {
  const sealed = [...getChain().blocks]
    .sort((a, b) => a.height - b.height)
    .flatMap((b) => b.transactions);
  const pending = getPendingBlock();
  return pending === null ? sealed : [...sealed, ...pending.transactions];
}

/** §3.2b — every minted token, newest first. */
export function getAssetViews(assetsDir: string = ASSETS_DIR): Promise<AssetView[]> {
  return assetViews(getAssets(), chainTransactions(), assetsDir);
}

/** One token by id, or `undefined` when the registry holds no such token. */
export async function getAssetView(
  tokenId: number,
  assetsDir: string = ASSETS_DIR,
): Promise<AssetView | undefined> {
  return (await getAssetViews(assetsDir)).find((v) => v.tokenId === tokenId);
}

/**
 * The token the recorded file *now* is, when `view` is not it — or `null`.
 *
 * This is what lets a superseded token's page say what happened instead of
 * leaving a reader with an unexplained absence. Matched on `file` and settled
 * by hashing: at most one token can be `current` for a given path, because a
 * path holds one byte-stream.
 */
export function supersedingToken(view: AssetView, views: readonly AssetView[]): number | null {
  if (view.current) return null;
  const holder = views.find((v) => v.tokenId !== view.tokenId && v.file === view.file && v.current);
  return holder === undefined ? null : holder.tokenId;
}

/**
 * §3.2b — the token's media type, re-derived from the name of the file that
 * hashes to it, or `null` when nothing on disk does.
 *
 * Not `record.mime`: that field is committed to no hash, so printing it for a
 * token whose file cannot be found would be stating an unverifiable claim about
 * an image nobody can see. Same rule as `bytesOnDisk`.
 */
export function assetMime(view: AssetView): string | null {
  return view.current ? mimeTypeFor(view.file) : null;
}

/**
 * The token's own bytes as a `data:` URI, for an image type — or `null`.
 *
 * A `data:` URI rather than an `/assets/<file>` URL on purpose. The bytes
 * embedded here are read and hashed against the token's own hash in this very
 * call, so what a reader sees is by construction the file the hash commits to.
 * A path would only be as trustworthy as the registry's uncommitted `file`
 * field, which after an image swap names a different image entirely.
 *
 * `null` for a superseded or missing token: the chain stores hashes, not bytes,
 * so an image the disk no longer holds is simply not recoverable, and showing
 * whatever now occupies its name is the falsehood this module exists to
 * prevent.
 */
export async function assetEmbed(
  view: AssetView,
  assetsDir: string = ASSETS_DIR,
): Promise<string | null> {
  const mime = assetMime(view);
  if (mime === null || !mime.startsWith('image/')) return null;
  const bytes = await committedBytes(assetsDir, view);
  if (bytes === null) return null;
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** The address that first sent this asset onto the chain (§3.7), or `null`. */
export function minterOf(view: AssetView): Hex | null {
  return view.referencedBy[0]?.from ?? null;
}
