import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { committedAssetNamed, emitSiteAssets } from './src/site/asset-files.ts';
import { ledgerBytes, openBlockBytes } from './src/site/chain-data.ts';
import { mimeTypeFor } from './src/chain/asset.ts';

/**
 * §3.2b — put the files posts reference into the build output.
 *
 * Astro renders `![Sơ đồ](/assets/so-do.svg)` as `<img src="/assets/so-do.svg">`
 * and has no idea `content/assets/` exists, so without this every image in
 * every post 404s. `public/` is not the answer: it would copy the directory
 * wholesale, including files no post references and images whose bytes the
 * chain no longer vouches for. `emitSiteAssets` copies by hash instead — see
 * `src/site/asset-files.ts` for the rule and why it is the rule.
 *
 * `astro:build:done` and not an earlier hook: `astro build` clears the output
 * directory on the way in, and the gallery page these files sit beside
 * (`dist/assets/index.html`) is written during the render.
 */
function assetFiles() {
  return {
    name: 'blogchain:asset-files',
    hooks: {
      // `astro dev` never reaches `astro:build:done`, so without this every
      // image in every post is a broken icon while writing — exactly when you
      // most need to see them. Same rule as the build: committed bytes only.
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((req, res, next) => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          if (!path.startsWith('/assets/')) return next();
          let file;
          try {
            file = decodeURIComponent(path.slice('/assets/'.length));
          } catch {
            return next();
          }
          // `/assets/` itself is the gallery page, not a file — let Astro have it.
          if (file === '') return next();
          committedAssetNamed(file)
            .then((asset) => {
              if (asset === null) return next();
              res.setHeader('Content-Type', mimeTypeFor(asset.file));
              res.setHeader('Cache-Control', 'no-store');
              res.end(Buffer.from(asset.bytes));
            })
            .catch(next);
        });
      },
      'astro:build:done': async ({ dir, logger }) => {
        const written = await emitSiteAssets(fileURLToPath(dir));
        logger.info(
          written.length === 0
            ? 'no committed asset file to copy'
            : `copied ${written.length} committed asset file(s): ${written.join(', ')}`,
        );
      },
    },
  };
}

/**
 * §7, §3.6 — the two published chain documents, answered in `astro dev` by the
 * same functions that write them into `dist/`.
 *
 * Without this they are not. `chain.pending.json` is a **file at the project
 * root**, and Vite's dev server serves project-root files as static assets from
 * a middleware that sits ahead of Astro's request handler. `GET
 * /chain.pending.json` therefore never reached `src/pages/chain.pending.json.ts`
 * in dev: the `openBlockBytes()` gate — the check that an open block recorded
 * against a different history, or one whose transaction hashes do not
 * recompute, is published nowhere — was dead code in the one mode the author
 * writes in. Measured, with a forged `prevHash` in the open block:
 *
 *   astro build  ->  no dist/chain.pending.json      (the gate refused it)
 *   astro dev    ->  200, the forged document        (Vite's file server)
 *
 * — a site publishing an open block claiming a history that is not this
 * chain's, beside pages that say no open block exists. The same divergence
 * covers every case `readPending` rejects: a fabricated hash, title or `value`
 * is refused by the build and served by dev. `/chain.json` is not shadowed
 * today (the committed file is `chain.lock.json`, so no `chain.json` sits at
 * the root to shadow it — confirmed: dev answers it with the route's
 * `charset=utf-8` and none of Vite's `ETag`/`Last-Modified`), but it is
 * intercepted here on the same rule anyway, so which of the two documents dev
 * answers honestly stops depending on what happens to be sitting at the
 * repository root.
 *
 * The rule is not restated here: `ledgerBytes()` and `openBlockBytes()` are the
 * functions the routes call, so there is one gate and dev cannot drift from the
 * build by editing one of two copies. `tests/site/chain-json.test.ts` holds
 * them to that — dev and build must agree byte for byte on an honest open
 * block, and dev must 404 the forged one the build omits.
 */
function chainDocuments() {
  /** Route path -> the bytes that route serves, or `null` for "no such document". */
  const DOCUMENTS = {
    '/chain.json': () => ledgerBytes(),
    '/chain.pending.json': () => openBlockBytes(),
  };

  return {
    name: 'blogchain:chain-documents',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((req, res, next) => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          const document = Object.hasOwn(DOCUMENTS, path) ? DOCUMENTS[path] : undefined;
          if (document === undefined) return next();
          let bytes;
          try {
            bytes = document();
          } catch (error) {
            return next(error);
          }
          // 404 and not `next()`: falling through would hand the request
          // straight back to the static layer this middleware exists to get in
          // front of, which is exactly how the refused document got published.
          if (bytes === null) {
            res.statusCode = 404;
            res.end();
            return;
          }
          // The content type the route states, character for character. Vite's
          // static layer answers a bare `application/json` with an `ETag`, and
          // that difference is how the shadowing was identified in the first
          // place.
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          // The open block is rewritten on every `chain:build`; a cached copy
          // in the author's browser is a stale answer to the one question this
          // document exists to answer.
          res.setHeader('Cache-Control', 'no-store');
          res.end(Buffer.from(bytes));
        });
      },
    },
  };
}

// Static output only. The whole point of this project is that it needs no
// server: the ledger is a committed file and every page is derived from it
// at build time.
export default defineConfig({
  output: 'static',
  site: 'https://lamter.example',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
  integrations: [assetFiles(), chainDocuments()],
});
