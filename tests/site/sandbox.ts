import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
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

/**
 * Slugs (and amended hashes) recorded in a sandbox's open block.
 *
 * Tests must assert that *their own* fixture is pending, never that the open
 * block holds exactly N transactions. The sandbox inherits the real repo's
 * `chain.pending.json`, so the moment the author publishes something in the
 * current month and commits it, every exact-count assertion starts failing for
 * a reason unrelated to what it tests.
 */
export function pendingIdsIn(dir: string): string[] {
  const path = join(dir, 'chain.pending.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    transactions?: { slug?: string | null; amends?: string | null }[];
  };
  return (parsed.transactions ?? []).map((t) => t.slug ?? t.amends ?? '').filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * The dev server
 * ------------------------------------------------------------------ */

/**
 * A running `astro dev` over a sandbox, answering real HTTP.
 *
 * Everything else in this file drives `astro build`, and for a long time that
 * was the whole of the site's coverage — which is how every image in every post
 * could be a broken icon in `astro dev` with 691 tests green. The asset copy ran
 * in `astro:build:done`, a hook the dev server never reaches, so `/assets/*`
 * 404ed in the one mode the author actually writes in and no test could see it.
 * A dev server is therefore not an optional extra surface: it is a second
 * pipeline with its own hooks, and anything asserted only of `dist/` is
 * asserted of half the system.
 */
export interface DevServer {
  /** Origin the server actually bound, e.g. `http://127.0.0.1:41337`. */
  readonly origin: string;
  /** `GET origin + path`, following no redirect so a 301 is visible as one. */
  get(path: string): Promise<Response>;
  /** Everything the server has printed, for a failure message. */
  output(): string;
  /** Idempotent, and safe to call on a server that already died. */
  stop(): Promise<void>;
}

/**
 * Every dev server this process started and has not yet stopped.
 *
 * A leaked `astro dev` outlives the suite and holds a port, so the next run
 * fails for a reason that has nothing to do with the code under test. `stop()`
 * in an `afterAll` covers the ordinary path; this covers the ones it cannot —
 * vitest itself dying, a `beforeAll` throwing before the handle is stored, an
 * interrupt from the terminal.
 */
const RUNNING = new Set<ChildProcess>();

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Negative pid: the whole process group. Vite starts helper processes
    // (esbuild's service, most visibly) that do not die with their parent, and
    // those are exactly the ones that go on holding a port.
    process.kill(-child.pid, signal);
  } catch {
    // Already gone, which is the outcome we wanted.
  }
}

process.once('exit', () => {
  for (const child of RUNNING) killGroup(child, 'SIGKILL');
});

/** A port nothing is listening on, from the OS's ephemeral range. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('the probe socket reported no port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the server, not the CLI.
 *
 * `astro dev` in Astro 7 is a process manager: it detects an agent environment
 * or `--background`, daemonises itself, writes `<root>/.astro/dev.json` and
 * prints JSON — and it refuses `--ignore-lock` in exactly that mode. All of
 * that is bookkeeping around one call, `dev()`, which is what the CLI ends up
 * running in the foreground and what a test wants to talk to. Calling it
 * directly keeps the fixture out of the daemon's lock file and its lifecycle
 * out of `astro dev stop`.
 *
 * In a child process rather than in-process, because `src/site/asset-files.ts`
 * and `src/site/chain-data.ts` read `content/assets` and `chain.lock.json` as
 * paths relative to the working directory. An in-process server would read the
 * *real* repository however carefully `root` were set, so the sandbox would be
 * testing the author's live chain, and `process.chdir()` is not available to a
 * test file that runs beside others.
 */
const BOOTSTRAP = `
import { dev } from 'astro';
const server = await dev({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: Number(process.env.BLOGCHAIN_DEV_PORT) },
  logLevel: 'warn',
});
process.stdout.write('DEV_READY ' + server.resolvedUrls.local[0] + '\\n');
`;

/** How long a cold `astro dev` may take to bind before it is called dead. */
const READY_TIMEOUT_MS = 120_000;

/**
 * The environment a dev server started *by a test* must not inherit.
 *
 * `VITEST` is not cosmetic. `astro/dist/vite-plugin-astro-server/plugin.js`
 * opens with `if (process.env.VITEST) return;`, so with that variable set
 * Astro's own request handler is never added to the middleware stack: the
 * server starts, prints its banner, answers `/assets/*` from the integration
 * hook — and returns connect's bare `Cannot GET /` for every page on the site.
 * A dev test that inherited vitest's environment would therefore "pass" its
 * asset assertions while proving that no page renders at all, which is a worse
 * blind spot than the one this file exists to close.
 *
 * `NODE_ENV` follows for the same reason in reverse: vitest sets it to `test`,
 * and the server under test is the one the author runs, which has
 * `development`.
 */
function devServerEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'VITEST' || key.startsWith('VITEST_')) delete env[key];
  }
  env['NODE_ENV'] = 'development';
  env['BLOGCHAIN_DEV_PORT'] = String(port);
  return env;
}

/**
 * Starts a dev server over `dir` and resolves once it is answering.
 *
 * Readiness is the server saying so, never a fixed sleep: a sleep long enough
 * for a loaded CI box wastes that long on every run, and one short enough to
 * feel quick is a flake waiting for the first slow machine.
 *
 * The port is an OS-assigned free one rather than Astro's 4321 — the author's
 * own dev server is usually on that, and a suite that fights it for the port
 * fails on the developer's machine and nowhere else. The origin is read back
 * from what the server reports rather than assumed from what was asked for, so
 * if something takes the port in the gap between probing and binding, Vite's
 * fallback to the next port is followed instead of silently talking to
 * whatever else is listening.
 */
export async function startDevSandbox(dir: string): Promise<DevServer> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--input-type=module', '-e', BOOTSTRAP], {
    cwd: dir,
    env: devServerEnv(port),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so `stop()` can take the helper processes with it.
    detached: true,
  });
  RUNNING.add(child);

  let log = '';
  const record = (chunk: Buffer): void => {
    log += chunk.toString('utf8');
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);

  let exited = false;
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      RUNNING.delete(child);
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    killGroup(child, 'SIGTERM');
    // A dev server that ignores SIGTERM still has to go, or it holds the port
    // for every later run. Escalate rather than wait forever.
    const forced = setTimeout(() => killGroup(child, 'SIGKILL'), 5_000);
    try {
      await done;
    } finally {
      clearTimeout(forced);
    }
  };

  const origin = await new Promise<string>((resolve, reject) => {
    let poll: ReturnType<typeof setInterval>;
    let deadline: ReturnType<typeof setTimeout>;
    const finish = (settle: () => void): void => {
      clearInterval(poll);
      clearTimeout(deadline);
      settle();
    };
    poll = setInterval(() => {
      const url = /DEV_READY (\S+)/.exec(log)?.[1];
      if (url !== undefined) finish(() => resolve(new URL(url).origin));
    }, 100);
    deadline = setTimeout(() => {
      finish(() => reject(new Error(`astro dev did not start within ${READY_TIMEOUT_MS} ms:\n${log}`)));
    }, READY_TIMEOUT_MS);
    // A server that dies on the way up must fail the test now, with its own
    // output, rather than after two minutes of a timeout that says nothing.
    void done.then(() => {
      if (/DEV_READY /.test(log)) return;
      finish(() => reject(new Error(`astro dev exited before it was ready:\n${log}`)));
    });
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });

  return {
    origin,
    get: (path) => fetch(origin + path, { redirect: 'manual' }),
    output: () => log,
    stop,
  };
}
