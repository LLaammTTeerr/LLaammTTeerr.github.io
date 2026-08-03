import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
export default function setup(): () => void {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  execFileSync(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], {
    cwd: root,
    stdio: 'inherit',
  });

  const startedAt = Date.now();
  /**
   * Remove the sandbox copies this run created.
   *
   * `sandboxRepo()` makes a full copy of the repository and the suite makes
   * dozens per run. Nothing removed them: one afternoon left 3052 directories
   * and filled a 7.7 GB tmpfs, after which ten unrelated test files failed at
   * once with disk errors that read exactly like product defects.
   *
   * Here rather than in `sandbox.ts`, because vitest runs test files in workers
   * whose exit does not fire a `process.on('exit')` handler registered there —
   * the obvious fix, which I measured leaking all 36 directories anyway. The
   * teardown returned from `globalSetup` runs once, in the main process, after
   * every worker is done.
   *
   * Only directories created after this run started, so a concurrent run's
   * sandboxes are left alone.
   */
  return () => {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith('blogchain-build-')) continue;
      const path = join(tmpdir(), name);
      try {
        if (statSync(path).birthtimeMs < startedAt) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Gone already, or not ours to remove. Never fail a green run on tidiness.
      }
    }
  };
}
