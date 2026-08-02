import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, symlinkSync } from 'node:fs';
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
 * Everything `astro build` and `chain:build` read. `node_modules` is symlinked
 * rather than copied (500 MB); `dist/` and `.astro/` are deliberately absent so
 * the sandbox build cannot pass by finding a stale artefact.
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
  'scripts',
  'src',
  'content',
];

/**
 * The open block exists only while something is unsealed, so it cannot go in
 * `COPIED` — most repository states have no such file. It must still be copied
 * when it is there: a post body may be vouched for by a *pending* amendment
 * alone, and a sandbox that silently dropped the record would fail its control
 * build for a reason that has nothing to do with what the test is checking.
 */
const COPIED_IF_PRESENT = ['chain.pending.json'];

export function sandboxRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blogchain-build-'));
  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  for (const entry of COPIED_IF_PRESENT) {
    if (existsSync(join(ROOT, entry))) cpSync(join(ROOT, entry), join(dir, entry));
  }
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

/**
 * Runs a real `chain:build` inside the sandbox at an injected clock, mining and
 * writing that copy's own `chain.lock.json` and `chain.pending.json`.
 *
 * `now` is required: the clock enters the system only through `--now=`
 * (see `scripts/resolve-now.ts`), and a test that let it default to today's
 * date would seal different months depending on when it ran.
 */
export function chainBuildSandbox(dir: string, now: string): BuildResult {
  const result = spawnSync(
    join(ROOT, 'node_modules/tsx/dist/cli.mjs'),
    ['scripts/build-chain.ts', `--now=${now}`],
    { cwd: dir, encoding: 'utf8' },
  );
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}
