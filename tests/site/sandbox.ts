import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A throwaway copy of the repository that a test may deliberately break, then
 * build, to assert on the *build's* behaviour rather than on a function's.
 *
 * Unit tests can only prove a guard is correct as a function; nothing stops a
 * route from ceasing to call it. Asserting that `npm run build` fails on a
 * deliberately broken input is the only check that survives a refactor of the
 * page that calls the guard.
 *
 * A copy rather than the repo itself, for two reasons: mutating
 * `content/posts/` or `chain.lock.json` in place would corrupt the working
 * tree if a test aborted mid-run, and vitest runs test files in parallel, so
 * the mutation window would be visible to every other test that reads them.
 * Nothing here writes inside the real repository.
 */

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Everything `astro build` reads. `node_modules` is symlinked rather than
 * copied (500 MB); `dist/` and `.astro/` are deliberately absent so the
 * sandbox build cannot pass by finding a stale artefact.
 *
 * If a future source directory is added and not listed here, the control
 * build in the drift test fails loudly rather than the sandbox silently
 * testing an incomplete project.
 */
const COPIED = [
  'astro.config.mjs',
  'chain.config.ts',
  'chain.lock.json',
  'package.json',
  'tsconfig.json',
  'src',
  'content',
];

export function sandboxRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogchain-build-'));
  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

export interface BuildResult {
  /** Zero on success. Astro exits non-zero when a page throws while rendering. */
  status: number | null;
  /** stdout and stderr together — Astro reports render errors on both. */
  output: string;
}

/** Runs a real `astro build` inside the sandbox. Never throws on failure. */
export function buildSandbox(dir: string): BuildResult {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build'],
    { cwd: dir, encoding: 'utf8' },
  );
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}
