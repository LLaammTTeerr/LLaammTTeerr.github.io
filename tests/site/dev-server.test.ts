import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainBuildSandbox, sandboxRepo, startDevSandbox, type DevServer } from './sandbox';
import { sha256Hex } from '../../src/chain/hash';

/**
 * §3.2b in `astro dev` — the mode the author writes in.
 *
 * Every other test in this directory drives `astro build`. That is why 691 of
 * them were green while every image in every post was a broken icon in dev: the
 * asset copy lived in `astro:build:done`, a hook `astro dev` never reaches, so
 * `/assets/*` 404ed for the entire time the author was looking at the page. The
 * bug was not subtle and not rare — it was every image, always — and the suite
 * could not see it, because nothing in the suite had ever started a dev server.
 *
 * So this file asserts over HTTP against a real one. The point is not to
 * re-test the asset rule, which `asset-files.test.ts` covers as a function and
 * `asset-drift.test.ts` covers through the build; it is that the *dev pipeline*
 * applies it. A route can only be proved to serve the right bytes by asking it.
 *
 * The rule the dev server owes the build (see `src/site/asset-files.ts`): serve
 * exactly the bytes the chain vouches for, under exactly the names a
 * transaction put on the site. Dev is where an author would most like the
 * friendlier answer — "just show me the file I have on disk" — and that is
 * precisely the answer that would let them publish an image the build then
 * refuses, discovering it at deploy time instead. Every 404 pinned below is
 * therefore a feature, not a limitation.
 */

const V1 = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n';
/** A swap nothing has recorded. Never written except inside a `try`/`finally`. */
const V2 = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>\n';
/** Bytes on the chain nowhere, in a file no post references. */
const ORPHAN = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>\n';

const FILE = 'so-do.svg';
const UNREFERENCED = 'khong-ai-dung.svg';
const SLUG = '2026-08-02-so-do';

/**
 * A dev server takes seconds to boot and each assertion is a real request, so
 * every test here carries its own timeout. Vitest's default is 5 s, which
 * several sandbox tests in this directory already finish uncomfortably close
 * to; a dev test left on the default is a flake with a start date.
 */
const HTTP_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 600_000;

const post = [
  '---',
  'title: "Sơ đồ khối"',
  'date: 2026-08-02',
  'tags: [meta]',
  'research: 2.0',
  '---',
  '',
  'Một bài viết có hình.',
  '',
  `![Hình](/assets/${FILE})`,
  '',
].join('\n');

describe('the dev server', () => {
  let dir = '';
  let server: DevServer;

  beforeAll(async () => {
    dir = sandboxRepo();
    mkdirSync(join(dir, 'content/assets/sub'), { recursive: true });
    writeFileSync(join(dir, 'content/assets', FILE), V1);
    // Referenced by nothing: "not on the chain at all; it is just a file" (§3.2b).
    writeFileSync(join(dir, 'content/assets', UNREFERENCED), ORPHAN);
    // A nested file holding bytes the chain *does* vouch for. The traversal
    // check below would pass trivially against a nested file of unknown bytes —
    // it has to be one that only the flat-directory rule keeps out.
    writeFileSync(join(dir, 'content/assets/sub/x.svg'), V1);
    writeFileSync(join(dir, 'content/posts', `${SLUG}.md`), post);

    // 2026-08 opens with the post; 2026-09 seals it and mints the token, so the
    // sealed registry is the path under test rather than only the open block.
    for (const now of ['2026-08-05', '2026-09-05']) {
      const built = chainBuildSandbox(dir, now);
      if (built.status !== 0) throw new Error(`chain:build at ${now} failed:\n${built.output}`);
    }

    server = await startDevSandbox(dir);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    // Unconditional, and in `afterAll` rather than at the end of the last test:
    // a leaked `astro dev` holds its port and its watchers for as long as the
    // machine is up, and the run after this one pays for it.
    await server?.stop();
  });

  it(
    'serves a referenced image as the exact bytes the chain committed to',
    async () => {
      const response = await server.get(`/assets/${FILE}`);
      expect(response.status, `dev did not serve /assets/${FILE}:\n${server.output()}`).toBe(200);
      // Not `image/*`: the browser decides whether an `<img>` renders or
      // downloads from this header, and `application/octet-stream` — what
      // `mimeTypeFor` falls back to — shows the broken icon the fix was for.
      expect(response.headers.get('content-type')).toBe('image/svg+xml');

      // The bytes, not merely a 200. A route that answered 200 with an empty
      // body, or with the *previous* contents of the file, is the same broken
      // image to a reader.
      const served = new Uint8Array(await response.arrayBuffer());
      expect(served).toEqual(new Uint8Array(readFileSync(join(dir, 'content/assets', FILE))));

      // And those bytes are the ones the chain vouches for, checked against the
      // token the seal minted rather than against the fixture constant.
      const registry = (
        JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
          assets: { hash: string; file: string }[];
        }
      ).assets;
      const token = registry.find((a) => a.file === FILE);
      expect(token, 'the fixture minted no token — the sealed path is untested').toBeDefined();
      expect(await sha256Hex(served)).toBe(token?.hash);
    },
    HTTP_TIMEOUT_MS,
  );

  it(
    'leaves /assets to the gallery page',
    async () => {
      // The file route lives at the same prefix as a real page. A middleware
      // that claimed everything under `/assets` would replace the token
      // registry with a 404 — and the build would still be fine, so nothing
      // else in the suite would notice.
      for (const path of ['/assets', '/assets/']) {
        const response = await server.get(path);
        expect(response.status, `${path} was not the gallery`).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/html/);
        const html = await response.text();
        expect(html).toContain('<h1>Assets</h1>');
      }
    },
    HTTP_TIMEOUT_MS,
  );

  it(
    '404s a file no post references',
    async () => {
      const response = await server.get(`/assets/${UNREFERENCED}`);
      expect(
        response.status,
        'dev published a url no transaction names',
      ).toBe(404);
      expect(await response.text()).not.toContain('<rect width="4"');
    },
    HTTP_TIMEOUT_MS,
  );

  it(
    'refuses any name with a path separator in it',
    async () => {
      // §3.2b puts assets in one flat directory and `referencedAssets` captures
      // `[A-Za-z0-9._-]+`, so a name containing a separator cannot be one the
      // chain ever committed to — whichever spelling it arrives in. The nested
      // file really is there and really does hold committed bytes, so a route
      // that resolved the path and hashed the result would serve it.
      for (const path of ['/assets/sub/x.svg', '/assets/sub%2Fx.svg', '/assets/sub%5Cx.svg']) {
        const response = await server.get(path);
        expect(response.status, `${path} escaped the flat directory`).toBe(404);
        expect(await response.text(), `${path} served the nested file`).not.toContain('<rect width="8"');
      }

      // And the same guard is what stops a traversal reaching the repository.
      // `package.json` is a file that certainly exists one level up.
      for (const path of ['/assets/..%2F..%2Fpackage.json', '/assets/%2e%2e%2fpackage.json']) {
        const response = await server.get(path);
        expect(response.status, `${path} escaped the assets directory`).toBe(404);
        expect(await response.text(), `${path} served a file outside content/assets`).not.toContain(
          '"name": "blogchain"',
        );
      }
    },
    HTTP_TIMEOUT_MS,
  );

  it(
    'renders a post page whose <img src> resolves against the same server',
    async () => {
      // The end-to-end shape of the original bug, and the only assertion here
      // that would have caught it without knowing where the fix belonged: the
      // page rendered, the `<img>` was in it, and the url it pointed at 404ed.
      const page = await server.get(`/tx/${SLUG}/`);
      expect(page.status, `the post page did not render in dev:\n${server.output()}`).toBe(200);
      const html = await page.text();

      const sources = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((src): src is string => src !== undefined && src.startsWith('/assets/'));
      expect(sources, 'the post rendered no image — the end-to-end case is not exercised').toContain(
        `/assets/${FILE}`,
      );

      for (const src of sources) {
        const image = await server.get(src);
        expect(image.status, `the page links ${src} and the server 404s it`).toBe(200);
        expect(image.headers.get('content-type')).toBe('image/svg+xml');
      }
    },
    HTTP_TIMEOUT_MS,
  );

  // Last, because it is the only test that edits the fixture out from under a
  // running server. Vite is watching that directory, and a write to it can set
  // a reload going; a test that leaves the server mid-reload for the next one
  // to inherit is a flake nobody will reproduce. It restores what it changed,
  // and nothing runs after it either way.
  it(
    '404s bytes swapped without a chain:build, and serves them again once restored',
    async () => {
      // The build's answer to an unrecorded swap is to fail (`asset-drift.test.ts`).
      // Dev cannot fail a build that is not running, so its answer is to stop
      // serving the file — the same refusal at the surface it has. If dev served
      // the new bytes, the author would see the new image, commit, and find out
      // at deploy time that the build refuses it.
      const path = join(dir, 'content/assets', FILE);
      writeFileSync(path, V2);
      try {
        const swapped = await server.get(`/assets/${FILE}`);
        expect(swapped.status, 'dev served bytes the chain does not vouch for').toBe(404);
        expect(await swapped.text()).not.toContain('<circle');
      } finally {
        writeFileSync(path, V1);
      }

      // Restored, it comes back — without restarting the server. Otherwise this
      // would be satisfied by a route that had simply stopped working, and the
      // author's edit-and-look loop would be broken in the other direction.
      const restored = await server.get(`/assets/${FILE}`);
      expect(restored.status, `the file did not come back after being restored:\n${server.output()}`).toBe(200);
      expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array(Buffer.from(V1)));
    },
    HTTP_TIMEOUT_MS,
  );
});
