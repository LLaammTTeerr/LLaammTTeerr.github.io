import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../chain/hash';
import type { AssetRecord, Hex } from '../chain/types';
import { getAssets, getPendingBlock, referencedAssetNames, type RecordedTx } from './chain-data';

/**
 * §3.2b — the files `dist` may serve under `/assets/`.
 *
 * A post body containing `![Sơ đồ](/assets/so-do.svg)` renders
 * `<img src="/assets/so-do.svg">`, and until this module existed nothing put a
 * file there: every image in every post 404ed. Copying `content/assets/`
 * wholesale would fix the 404 and break the thing the chain is for, so this
 * copies by hash instead.
 *
 * **The rule: `dist` serves exactly the bytes the chain vouches for.** A file
 * is written out when its bytes hash to a value the chain commits to — a
 * hash in the sealed asset registry, or one in a transaction sitting in the
 * open block (those posts have pages too, and their images must work). Nothing
 * else is written:
 *
 *  - A file no post references "is not on the chain at all; it is just a file"
 *    (§3.2b). Publishing it would put a url on the site that no transaction
 *    covers.
 *  - A file whose bytes no longer hash to any committed value is the
 *    superseded image `/asset/<id>` already declines to show
 *    (`src/site/assets-view.ts`). Serving it at `/assets/<file>` would be that
 *    same falsehood at a different surface: bytes under a path the chain does
 *    not vouch for.
 *
 * Selection is by **bytes and by name together**, and the output name is the
 * name **on disk**. The registry's `file` field is committed to no hash
 * anywhere (see `registryProblem` in `src/chain/verify.ts`), so it decides
 * nothing here — the same rule `bytesOnDisk` and `assetMime` are under.
 *
 * The names come from `referencedAssetNames()`: the filenames the bodies the
 * chain currently vouches for actually embed, which is precisely the set of
 * `/assets/<file>` urls the site emits an `<img src>` for. Selecting on bytes
 * alone published urls no transaction names. Two ways, both driven:
 * `cp so-do.svg copy-of-so-do.svg` shipped `/assets/copy-of-so-do.svg`; and
 * after an image swap, restoring the *old* bytes under any other name shipped
 * them too — while `/asset/1` was saying, correctly, that the content that
 * token commits to cannot be reconstructed. The site does not get to publish
 * bytes at a url of its own invention, whatever they hash to.
 *
 * Build-time only: it reads the filesystem, so nothing in the browser bundle
 * may import it. Reads no clock (§14), like everything else under `src/site/`.
 */

const ASSETS_DIR = 'content/assets';

/** The subdirectory of `dist` that `/assets/<file>` resolves into. */
const OUT_SUBDIR = 'assets';

export interface CommittedAsset {
  /** The filename on disk, which is also the name written into `dist`. */
  file: string;
  /** sha256 over the raw bytes — the value that matched the chain. */
  hash: Hex;
  /** The bytes that were hashed. Written out as-is; never re-read. */
  bytes: Uint8Array;
}

/**
 * Every asset hash the chain vouches for.
 *
 * Both halves are needed. The registry is minted when a block *seals*
 * (`src/chain/build.ts`), so a post published this month has its asset hashes
 * in `chain.pending.json` and nowhere else; a copy driven by `getAssets()`
 * alone would 404 every image on every page of the current month, which is the
 * state a working repository spends most of its time in.
 */
export function committedAssetHashes(
  records: readonly AssetRecord[],
  transactions: readonly { assets: readonly Hex[] }[],
): Set<Hex> {
  const hashes = new Set<Hex>();
  for (const rec of records) hashes.add(rec.hash);
  for (const tx of transactions) {
    for (const hash of tx.assets) hashes.add(hash);
  }
  return hashes;
}

/**
 * The files directly inside `assetsDir` that a post currently references **by
 * that name** and whose raw bytes hash to one of `hashes`, sorted by filename.
 *
 * Both conditions, and neither alone is enough. The bytes are what the chain
 * vouches for; the name is what a transaction actually put on the site. A file
 * matching only the bytes is a url the chain never named (see the module doc);
 * a file matching only the name is the drifted image `getPostContent` fails the
 * build over.
 *
 * Sorted rather than in `readdir` order: two consecutive builds must produce
 * byte-identical output, and directory order is filesystem-dependent.
 *
 * Top level only. A post can only reference `/assets/<file>` with no slash in
 * it (`referencedAssets` in `src/chain/asset.ts` captures `[A-Za-z0-9._-]+`),
 * so a nested file is unreachable by any post and flattening one into the
 * output would invent a url the chain never named.
 *
 * A missing directory is empty, not an error: `content/assets/` may legitimately
 * not exist, and a build must not fail because the author has published no
 * images.
 */
export async function committedAssetFiles(
  assetsDir: string,
  hashes: ReadonlySet<Hex>,
  referenced: ReadonlySet<string>,
): Promise<CommittedAsset[]> {
  if (hashes.size === 0 || referenced.size === 0 || !existsSync(assetsDir)) return [];

  const names = readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => referenced.has(name))
    .sort();

  const out: CommittedAsset[] = [];
  for (const file of names) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(assetsDir, file)));
    } catch {
      // Unreadable, or gone between the listing and the read. A file that
      // cannot be read is simply not one the build can vouch for; that is not
      // a reason to fail the build.
      continue;
    }
    // Raw bytes, no normalization — an asset is binary, not text (§3.2b).
    const hash = await sha256Hex(bytes);
    if (hashes.has(hash)) out.push({ file, hash, bytes });
  }
  return out;
}

/**
 * Writes the committed files into `outDir`, returning the filenames written.
 *
 * The bytes written are the ones `committedAssetFiles` hashed, not a second
 * read of the path: what lands in `dist` is by construction what was checked
 * against the chain. Same reasoning as `assetEmbed`'s, which builds its `data:`
 * uri from bytes it hashed in the same call.
 *
 * `outDir` is `dist/assets`, which the build has usually already created for
 * the gallery page — the asset files become siblings of that `index.html`, and
 * nothing here touches it.
 */
export async function writeCommittedAssets(
  assetsDir: string,
  outDir: string,
  hashes: ReadonlySet<Hex>,
  referenced: ReadonlySet<string>,
): Promise<string[]> {
  const files = await committedAssetFiles(assetsDir, hashes, referenced);
  if (files.length === 0) return [];
  mkdirSync(outDir, { recursive: true });
  for (const asset of files) {
    const path = join(outDir, asset.file);
    // `astro build` clears the output directory on the way in, so anything
    // already at this path was written by the render — in practice
    // `dist/assets/index.html`, the gallery. An asset named `index.html` is a
    // legal reference (`referencedAssets` accepts it) that would silently
    // replace the page listing every token with a file. Fail loudly and name
    // the fix rather than clobber a route or quietly 404 the image.
    if (existsSync(path)) {
      throw new Error(
        `content/assets/${asset.file} would overwrite the built page at /assets/${asset.file} — rename the file`,
      );
    }
    writeFileSync(path, asset.bytes);
  }
  return files.map((a) => a.file);
}

/**
 * The transactions in the open block, or none. `getPendingBlock` returns null
 * for a record left over from a chain this one no longer is, and those posts
 * get no pages either — so their assets are not served, which keeps this
 * consistent with what the site actually renders.
 */
function pendingTransactions(): RecordedTx[] {
  return getPendingBlock()?.transactions ?? [];
}

/**
 * The production entry point, called from the `astro:build:done` hook in
 * `astro.config.mjs`: emit `<distDir>/assets/` from the live chain.
 */
export function emitSiteAssets(
  distDir: string,
  assetsDir: string = ASSETS_DIR,
): Promise<string[]> {
  return writeCommittedAssets(
    assetsDir,
    join(distDir, OUT_SUBDIR),
    committedAssetHashes(getAssets(), pendingTransactions()),
    referencedAssetNames(),
  );
}

/**
 * The bytes `/assets/<file>` should serve, or `null` if the chain does not
 * vouch for them.
 *
 * `astro dev` never runs `astro:build:done`, so without a dev-server route
 * every image in every post is a broken icon while writing — the one situation
 * where you most need to see them. This is what that route serves, and it
 * applies exactly the rule `emitSiteAssets` applies to the build: a file whose
 * bytes hash to something a current transaction committed to, and nothing else.
 * Swap an image without running `chain:build` and dev stops serving it, which
 * is the same answer the build gives by failing.
 */
export async function committedAssetNamed(
  file: string,
  assetsDir: string = ASSETS_DIR,
): Promise<CommittedAsset | null> {
  // A name only — never a path. `foo/../../etc/passwd` and `sub/dir/x.png` are
  // both rejected: §3.2b puts assets in one flat directory, so a name with a
  // separator in it cannot be one the chain ever named.
  if (file === '' || file.includes('/') || file.includes('\\')) return null;
  const found = await committedAssetFiles(
    assetsDir,
    committedAssetHashes(getAssets(), pendingTransactions()),
    referencedAssetNames(),
  );
  return found.find((a) => a.file === file) ?? null;
}
