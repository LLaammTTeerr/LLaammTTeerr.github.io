import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { emitSiteAssets } from './src/site/asset-files.ts';

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

// Static output only. The whole point of this project is that it needs no
// server: the ledger is a committed file and every page is derived from it
// at build time.
export default defineConfig({
  output: 'static',
  site: 'https://lamter.example',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
  integrations: [assetFiles()],
});
