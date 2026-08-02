import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Build the site once, before any test file runs.
 *
 * Four test files assert against `dist/`, which is gitignored and therefore
 * absent on a fresh clone and stale after every source edit. With the build
 * outside the test command, `npm test` validated whatever `dist/` happened
 * to hold: edit a template, run the suite, and the no-flash, block-ordering
 * and meter assertions all passed against the *previous* build. That is a
 * green suite proving nothing about the code under test.
 *
 * This lives in vitest's `globalSetup` rather than in the npm script so it
 * cannot be bypassed by running `vitest` directly, and so it runs exactly
 * once per suite instead of once per test file.
 */
export default function setup(): void {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  execFileSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
}
