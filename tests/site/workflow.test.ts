import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DIST } from './dist';

/**
 * What GitHub Actions does with this repository.
 *
 * The workflow is the one file in the project that nothing local executes:
 * `npm test` cannot run it, `astro build` never reads it, and its first real
 * run happens on a machine nobody is watching, against a chain of 154 commits
 * that is about to become public. So it is checked the way a source file is —
 * **parsed**, not grepped. A test that asserts the file "mentions `npm test`"
 * is green against a comment that mentions it, and this repository has already
 * shipped a test that passed against a hard-coded domain and one that compared
 * zero to zero. The assertions below are about the parsed structure: which
 * commands run, in which order, in which job, under which condition.
 *
 * The one property that gets a text scan as well is the chain rebuild, and only
 * because there a false positive costs nothing — see `never rebuilds the chain`.
 */

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOW = join(ROOT, '.github/workflows/deploy.yml');
const PACKAGE = join(ROOT, 'package.json');
const LOCK = join(ROOT, 'chain.lock.json');

/** The package script the workflow must run to check the committed ledger. */
const LEDGER_CHECK = 'chain:verify';

/* ------------------------------------------------------------------ *
 * Reading the workflow
 * ------------------------------------------------------------------ */

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Job {
  'runs-on'?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: unknown;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown> | null;
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs?: Record<string, Job>;
}

function workflowText(): string {
  return readFileSync(WORKFLOW, 'utf8');
}

/**
 * The workflow as YAML, not as text.
 *
 * `yaml` reads YAML 1.2, where a bare `on:` stays the *string* `on`. Under
 * YAML 1.1 — which `js-yaml` still defaults to — it would be the boolean
 * `true`, and every lookup of `wf.on` below would silently find nothing. Pinned
 * in a test rather than left as a comment, because the failure mode is a whole
 * describe block passing vacuously.
 */
function workflow(): Workflow {
  const parsed: unknown = parse(workflowText());
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${WORKFLOW} does not parse to a mapping`);
  }
  return parsed as Workflow;
}

function jobs(wf: Workflow): Record<string, Job> {
  const found = wf.jobs;
  if (found === undefined) throw new Error('the workflow declares no jobs');
  return found;
}

function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return typeof job.needs === 'string' ? [job.needs] : job.needs;
}

/**
 * Job ids in an order consistent with `needs`.
 *
 * Declaration order is not run order — jobs with no dependency between them run
 * in parallel — so an ordering assertion that walked the file top to bottom
 * would be asserting something GitHub does not promise. This also throws on a
 * `needs` naming a job that does not exist, which GitHub rejects at load time
 * and which no other check here would notice.
 */
function jobOrder(wf: Workflow): string[] {
  const all = jobs(wf);
  const order: string[] = [];
  let pending = Object.keys(all);
  while (pending.length > 0) {
    const ready = pending.filter((id) => needsOf(all[id]!).every((n) => order.includes(n)));
    if (ready.length === 0) {
      throw new Error(`jobs have a cyclic or dangling \`needs\`: ${pending.join(', ')}`);
    }
    order.push(...ready);
    pending = pending.filter((id) => !ready.includes(id));
  }
  return order;
}

function stepsOf(job: Job): Step[] {
  return job.steps ?? [];
}

/**
 * Every shell command the workflow runs, in the order it runs them.
 *
 * One entry per *line* of a `run:` block, so a multi-line step is not one
 * opaque string that only a substring match could inspect. Blank lines and
 * comment lines are dropped: a command commented out inside a `run:` block is
 * not a command, and counting it would make `never rebuilds the chain`
 * unfalsifiable in the other direction.
 */
function runSteps(wf: Workflow): string[] {
  const out: string[] = [];
  for (const id of jobOrder(wf)) {
    for (const step of stepsOf(jobs(wf)[id]!)) {
      if (typeof step.run !== 'string') continue;
      for (const line of step.run.split('\n')) {
        const command = line.trim();
        if (command !== '' && !command.startsWith('#')) out.push(command);
      }
    }
  }
  return out;
}

/**
 * Where a command runs in the sequence — and a hard failure when it does not
 * run at all.
 *
 * `indexOf` would return `-1`, and `-1` compares *smaller* than every real
 * index, so `expect(indexOf(build)).toBeGreaterThan(indexOf(test))` stays green
 * the moment `npm test` is deleted from the workflow. That is the exact shape
 * of test this project has shipped and had to retract. Throwing here makes a
 * missing step fail the ordering test itself, which is what the mutation
 * `drop npm test` is run against.
 */
function orderOf(steps: string[], command: string): number {
  const index = steps.indexOf(command);
  if (index === -1) {
    throw new Error(`the workflow never runs \`${command}\`; it runs:\n  ${steps.join('\n  ')}`);
  }
  return index;
}

/** Ids of jobs holding a step that uses the named action, whatever its version. */
function jobsUsing(wf: Workflow, action: string): string[] {
  return jobOrder(wf).filter((id) =>
    stepsOf(jobs(wf)[id]!).some((s) => typeof s.uses === 'string' && s.uses.startsWith(`${action}@`)),
  );
}

/** The single job holding the named action, or a failure naming what was found. */
function jobUsing(wf: Workflow, action: string): [string, Job] {
  const found = jobsUsing(wf, action);
  if (found.length !== 1) {
    throw new Error(`expected exactly one job using ${action}, found ${found.length}: ${found.join(', ')}`);
  }
  return [found[0]!, jobs(wf)[found[0]!]!];
}

/** The job that runs the build — identified by what it does, not by its name. */
function buildJob(wf: Workflow): [string, Job] {
  const found = jobOrder(wf).filter((id) =>
    stepsOf(jobs(wf)[id]!).some((s) => (s.run ?? '').includes('npm run build')),
  );
  if (found.length !== 1) {
    throw new Error(`expected exactly one job running \`npm run build\`, found ${found.length}`);
  }
  return [found[0]!, jobs(wf)[found[0]!]!];
}

/**
 * Evaluate the sliver of GitHub's expression language this workflow is allowed
 * to use: `github.ref == '<literal>'`, bare or wrapped in `${{ }}`.
 *
 * Deliberately tiny and deliberately **total in the failing direction** — it
 * throws on anything it cannot read rather than guessing. A condition rewritten
 * into a richer form (`startsWith(...)`, `&&`, a `github.event` lookup) then
 * fails this test loudly instead of being quietly treated as "true", which is
 * how a deploy gate stops gating without anyone noticing.
 */
function runsAt(condition: string | undefined, ref: string): boolean {
  if (condition === undefined) return true;
  const expression = /^\$\{\{(.*)\}\}$/.exec(condition.trim())?.[1] ?? condition;
  const match = /^\s*github\.ref\s*==\s*'([^']*)'\s*$/.exec(expression);
  if (match === null) {
    throw new Error(
      `this test can only evaluate \`github.ref == '…'\`, but the workflow says \`${condition}\``,
    );
  }
  return ref === match[1];
}

/** Whether a job runs at all for a push to `ref`, condition and steps together. */
function jobRunsAt(job: Job, ref: string): boolean {
  return runsAt(job.if, ref) && stepsOf(job).every((s) => runsAt(s.if, ref));
}

/* ------------------------------------------------------------------ *
 * Reading what the workflow must agree with
 * ------------------------------------------------------------------ */

function packageJson(): { engines?: { node?: string }; scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
}

/**
 * The node version `package.json` declares as its floor, as an exact version.
 *
 * Derived rather than written down twice: a literal here would agree with
 * `engines.node` on the day it was typed and never again. The regex is narrow
 * on purpose — a range this cannot read as a single floor (`^22`, `>=22 <24`)
 * throws, because silently picking one end of it is how CI ends up on a version
 * the project never declared.
 */
function requiredNode(): string {
  const range = packageJson().engines?.node;
  if (range === undefined) throw new Error('package.json declares no `engines.node`');
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range);
  if (match === null) {
    throw new Error(`package.json declares engines.node as \`${range}\`, not a single floor`);
  }
  return match[1]!;
}

/* ------------------------------------------------------------------ *
 * The file itself
 * ------------------------------------------------------------------ */

describe('the workflow file', () => {
  it('is valid yaml declaring jobs GitHub can run', () => {
    const wf = workflow();
    const all = jobs(wf);
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [id, job] of Object.entries(all)) {
      expect(job['runs-on'], `job ${id} names no runner`).toBeTypeOf('string');
      expect(stepsOf(job).length, `job ${id} has no steps`).toBeGreaterThan(0);
      for (const step of stepsOf(job)) {
        const kind = [step.uses, step.run].filter((v) => typeof v === 'string');
        expect(kind.length, `a step in ${id} is neither a \`uses\` nor a \`run\``).toBe(1);
      }
    }
    // `needs` resolves — this throws on a dangling or cyclic dependency.
    expect(jobOrder(wf).length).toBe(Object.keys(all).length);
  });

  it('keeps its trigger under the key `on`, not the boolean `true`', () => {
    // The YAML 1.1 trap, pinned. `on` is a 1.1 boolean and a 1.2 string; if the
    // parser this file uses ever changed its mind, every `wf.on` lookup below
    // would find `undefined` and pass by looking at nothing.
    const wf = workflow();
    expect(Object.keys(wf)).toContain('on');
    expect(Object.keys(wf)).not.toContain('true');
    expect(wf.on).toBeTypeOf('object');
  });

  it('finds real commands to inspect', () => {
    // Anti-vacuity for `runSteps` itself. Every ordering assertion below is
    // meaningless if the helper returns everything, or nothing.
    const steps = runSteps(workflow());
    expect(steps.length).toBeGreaterThan(3);
    expect(steps).not.toContain('');
    expect(steps).not.toContain('npm run nonexistent-script');
    for (const command of steps) expect(command).toBe(command.trim());
  });
});

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

describe('the checks it runs before publishing', () => {
  it('runs the same checks a developer runs, before publishing', () => {
    const steps = runSteps(workflow());
    expect(steps).toContain('npm run typecheck');
    expect(steps).toContain('npm test');
    expect(orderOf(steps, 'npm run build')).toBeGreaterThan(orderOf(steps, 'npm test'));
    expect(orderOf(steps, 'npm test')).toBeGreaterThan(orderOf(steps, 'npm run typecheck'));
    expect(orderOf(steps, 'npm run typecheck')).toBeGreaterThan(orderOf(steps, 'npm ci'));
  });

  it('installs from the lockfile, never resolving fresh', () => {
    // `npm install` may pick a newer dependency than the one the lockfile
    // records, so CI would be checking a tree that exists nowhere else — and
    // it rewrites `package-lock.json`, which is committed.
    const steps = runSteps(workflow());
    expect(steps).toContain('npm ci');
    for (const command of steps) {
      expect(command, `\`${command}\` resolves dependencies afresh`).not.toMatch(
        /\bnpm\s+(install|i|add|update|up)\b/,
      );
    }
  });

  it('verifies the committed ledger by name, before the build', () => {
    // `npm test` already proves the chain verifies, and `npm run build` refuses
    // a ledger that disagrees with `content/`. This step is here so the CI log
    // states the project's central claim in its own line, where a reader
    // looking for "was the chain checked?" will find it.
    const steps = runSteps(workflow());
    expect(orderOf(steps, `npm run ${LEDGER_CHECK}`)).toBeLessThan(
      orderOf(steps, 'npm run build'),
    );
  });

  it('runs only scripts package.json defines', () => {
    // The coupling that makes every assertion above about a command that can
    // actually run. A workflow naming `npm run typechek` satisfies nothing here
    // and would fail on GitHub with exit code 1 and no other explanation.
    const defined = Object.keys(packageJson().scripts ?? {});
    const named = runSteps(workflow())
      .map((command) => /^npm run ([\w:.-]+)/.exec(command)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(named.length).toBeGreaterThan(2);
    for (const name of named) {
      expect(defined, `the workflow runs \`npm run ${name}\`, which package.json does not define`)
        .toContain(name);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The ledger is committed history, not a build artifact
 * ------------------------------------------------------------------ */

/**
 * Anything that would re-mine the chain.
 *
 * Both spellings, because the npm script and the file it runs are separately
 * reachable: `npm run chain:build` and `tsx scripts/build-chain.ts` do the same
 * thing and only one of them contains `chain:build`.
 */
const REBUILDS_CHAIN = /chain:build|build-chain/;

describe('the ledger is committed history, not a build artifact', () => {
  it('never rebuilds the chain', () => {
    // Re-mining in CI would hash against CI's clock and rewrite blocks the
    // whole project treats as frozen, and it would mint an amendment nobody
    // reviewed for any post edited without one. When a post has been edited
    // without an amendment, `npm run build` fails, names the file and prints
    // both hashes — **that failure is the guarantee, and CI's job is to let it
    // happen.** A `chain:build` step here would make it disappear.
    for (const command of runSteps(workflow())) {
      expect(command, `\`${command}\` would re-mine the ledger in CI`).not.toMatch(REBUILDS_CHAIN);
    }
    // And as text, comments included. A false positive here costs a comment
    // rewrite; a false negative costs the ledger.
    expect(workflowText()).not.toMatch(REBUILDS_CHAIN);
  });

  it('would notice a chain rebuild in any shape it could arrive in', () => {
    // The check above is an absence, and an absence proves nothing about the
    // checker. These are the ways a rebuild could actually be added — by
    // someone "fixing" a red build the honest way, which is the whole
    // temptation this guard exists against.
    for (const shape of [
      'npm run chain:build',
      'npm run chain:build -- --now=2026-08-03',
      'npx tsx scripts/build-chain.ts',
      'node node_modules/tsx/dist/cli.mjs scripts/build-chain.ts --now=$(date +%F)',
      'npm run demo:seed && npm run chain:build',
    ]) {
      expect(shape, `${shape} would slip past the guard`).toMatch(REBUILDS_CHAIN);
    }
  });

  it('does not ban the ledger check along with the rebuild', () => {
    // The trap on the other side: a guard broad enough to match `chain:` would
    // forbid the verification step this workflow is required to run, and the
    // two tests would be unsatisfiable together.
    expect(`npm run ${LEDGER_CHECK}`).not.toMatch(REBUILDS_CHAIN);
  });
});

/* ------------------------------------------------------------------ *
 * The ledger check can actually fail
 * ------------------------------------------------------------------ */

/**
 * Run the ledger check against a directory holding a `chain.lock.json` of our
 * choosing.
 *
 * The script resolves the lock relative to the working directory, so a copy of
 * the repository is not needed — only a directory with a ledger in it. Nothing
 * here writes inside the real repository.
 */
function ledgerCheckAt(lock: string | null): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'blogchain-ledger-'));
  if (lock !== null) writeFileSync(join(dir, 'chain.lock.json'), lock, 'utf8');
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'scripts/verify-chain.ts')],
    { cwd: dir, encoding: 'utf8' },
  );
  return { status: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

describe('the ledger check', () => {
  it('passes on the ledger this repository ships', () => {
    const result = ledgerCheckAt(readFileSync(LOCK, 'utf8'));
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/chain\.lock\.json/);
  });

  it('fails on a ledger whose proof of work has been forged', () => {
    // A block whose recorded `nonce` is not the one that was mined: every field
    // still parses, the file is still valid JSON, and `verifyChain` is the only
    // thing in the project that notices.
    const chain = JSON.parse(readFileSync(LOCK, 'utf8')) as {
      blocks: { nonce: number }[];
    };
    expect(chain.blocks.length, 'the shipped ledger has no block to forge').toBeGreaterThan(0);
    chain.blocks[0]!.nonce += 1;
    const result = ledgerCheckAt(JSON.stringify(chain, null, 2));
    expect(result.status, 'a forged nonce was reported clean').not.toBe(0);
  });

  it('fails when there is no ledger at all', () => {
    // The vacuity trap this check would otherwise walk straight into:
    // `readLock` answers a missing file with an *empty* chain, and an empty
    // chain verifies. Without this the CI log would print a confident
    // `integrity OK` for a repository that had lost `chain.lock.json`.
    const result = ledgerCheckAt(null);
    expect(result.status, 'a missing ledger was reported clean').not.toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The node version
 * ------------------------------------------------------------------ */

describe('the node version', () => {
  it('runs on the node version package.json requires', () => {
    const wf = workflow();
    const versions = jobOrder(wf)
      .flatMap((id) => stepsOf(jobs(wf)[id]!))
      .filter((s) => (s.uses ?? '').startsWith('actions/setup-node@'))
      .map((s) => s.with?.['node-version']);
    expect(versions.length, 'no job installs node at all').toBeGreaterThan(0);
    for (const version of versions) {
      // A string, not a number: unquoted `22.12` in YAML is the float 22.12,
      // and `actions/setup-node` would install 22.12.x — a different thing from
      // the exact floor, silently.
      expect(version, 'the node version is not quoted in the yaml').toBeTypeOf('string');
      expect(version).toBe(requiredNode());
    }
  });

  it('installs node before it runs anything with npm', () => {
    const wf = workflow();
    for (const id of jobOrder(wf)) {
      const steps = stepsOf(jobs(wf)[id]!);
      const setup = steps.findIndex((s) => (s.uses ?? '').startsWith('actions/setup-node@'));
      const firstNpm = steps.findIndex((s) => (s.run ?? '').includes('npm '));
      if (firstNpm === -1) continue;
      expect(setup, `job ${id} runs npm without installing node`).not.toBe(-1);
      expect(setup, `job ${id} runs npm before installing node`).toBeLessThan(firstNpm);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

/** Every permission scope granted anywhere in the file, and at what level. */
function permissionsGranted(wf: Workflow): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (perms: Record<string, string> | undefined): void => {
    for (const [scope, level] of Object.entries(perms ?? {})) {
      const levels = out.get(scope) ?? new Set<string>();
      levels.add(level);
      out.set(scope, levels);
    }
  };
  add(wf.permissions);
  for (const job of Object.values(jobs(wf))) add(job.permissions);
  return out;
}

/** What a job actually holds: its own block if it has one, else the file's. */
function effectivePermissions(wf: Workflow, job: Job): Record<string, string> {
  return job.permissions ?? wf.permissions ?? {};
}

describe('the token it runs with', () => {
  it('grants only the three scopes publishing to Pages needs', () => {
    const granted = permissionsGranted(workflow());
    expect([...granted.keys()].sort()).toEqual(['contents', 'id-token', 'pages']);
    expect([...granted.get('contents')!]).toEqual(['read']);
    expect([...granted.get('pages')!]).toEqual(['write']);
    expect([...granted.get('id-token')!]).toEqual(['write']);
  });

  it('keeps the Pages token away from the job that runs the project code', () => {
    // `npm ci` executes install scripts from the whole dependency tree, and
    // `npm test` and `npm run build` run this repository's own code. None of
    // that needs to be able to publish, and the deploy job never checks out a
    // working tree for it to reach. Splitting the grant is the difference
    // between "a compromised dependency can read this public repository" and
    // "a compromised dependency can replace the published site".
    const wf = workflow();
    const held = effectivePermissions(wf, buildJob(wf)[1]);
    expect(held).toEqual({ contents: 'read' });
  });

  it('declares a default so a job that says nothing is not given everything', () => {
    // With no workflow-level block, GitHub falls back to the repository default,
    // which can be read-and-write on every scope.
    expect(workflow().permissions).toEqual({ contents: 'read' });
  });
});

/* ------------------------------------------------------------------ *
 * Publishing
 * ------------------------------------------------------------------ */

describe('publishing', () => {
  it('publishes the directory the build actually writes', () => {
    const wf = workflow();
    const [, job] = jobUsing(wf, 'actions/upload-pages-artifact');
    const upload = stepsOf(job).find((s) => (s.uses ?? '').startsWith('actions/upload-pages-artifact@'))!;
    const path = String(upload.with?.['path'] ?? '').replace(/^\.\//, '').replace(/\/$/, '');
    // `DIST` is where this suite reads the build from, so the artifact and the
    // tests cannot end up pointing at different directories.
    expect(path).toBe(DIST);
  });

  it('uploads only after every check has passed', () => {
    const wf = workflow();
    const [id, job] = jobUsing(wf, 'actions/upload-pages-artifact');
    expect(id, 'the upload is in a different job from the build').toBe(buildJob(wf)[0]);
    const steps = stepsOf(job);
    const upload = steps.findIndex((s) => (s.uses ?? '').startsWith('actions/upload-pages-artifact@'));
    for (const command of ['npm test', 'npm run typecheck', 'npm run build', `npm run ${LEDGER_CHECK}`]) {
      const at = steps.findIndex((s) => (s.run ?? '').includes(command));
      expect(at, `the workflow never runs \`${command}\``).not.toBe(-1);
      expect(at, `\`${command}\` runs after the artifact is uploaded`).toBeLessThan(upload);
    }
  });

  it('deploys in a job that waits for the checks', () => {
    const wf = workflow();
    const [deployId, deploy] = jobUsing(wf, 'actions/deploy-pages');
    expect(deployId).not.toBe(buildJob(wf)[0]);
    expect(needsOf(deploy)).toContain(buildJob(wf)[0]);
    // The deploy job must not re-run any of the project's own commands: it
    // holds the Pages token, and it does not check the repository out.
    expect(stepsOf(deploy).filter((s) => typeof s.run === 'string')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Which branch publishes
 * ------------------------------------------------------------------ */

/** Refs a push can arrive on that must never publish. */
const NOT_MAIN = [
  'refs/heads/deploy',
  'refs/heads/feature/assets',
  'refs/heads/gh-pages',
  'refs/heads/mainline',
  'refs/tags/v1.0.0',
];

describe('which branch publishes', () => {
  it('publishes from main and from nowhere else', () => {
    const wf = workflow();
    const [, deploy] = jobUsing(wf, 'actions/deploy-pages');
    expect(jobRunsAt(deploy, 'refs/heads/main'), 'main does not publish').toBe(true);
    for (const ref of NOT_MAIN) {
      expect(jobRunsAt(deploy, ref), `a push to ${ref} would publish`).toBe(false);
    }
  });

  it('still runs every check on a push that will not publish', () => {
    // The point of running on other branches at all: the checks are most of
    // this workflow's value, and they are worth having wherever work happens.
    const wf = workflow();
    const [, build] = buildJob(wf);
    for (const ref of NOT_MAIN) {
      expect(jobRunsAt(build, ref), `a push to ${ref} would skip the checks`).toBe(true);
    }
  });

  it('is triggered by a push to any branch', () => {
    // A `branches:` filter here would make the test above vacuous: the job's
    // condition would be satisfied on a branch the workflow never starts on.
    const on = workflow().on ?? {};
    expect(Object.keys(on)).toContain('push');
    const push = on['push'];
    if (push !== null && typeof push === 'object') {
      expect(
        Object.keys(push),
        'the push trigger filters branches, so other branches are never checked',
      ).not.toContain('branches');
    }
  });
});
