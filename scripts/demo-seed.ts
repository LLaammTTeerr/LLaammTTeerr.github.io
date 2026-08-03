/**
 * Seeds the demo corpus so every page can be previewed at realistic density.
 *
 * `npm run demo:seed` — writes the files and replays the chain month by month.
 * `npm run demo:clear` — removes exactly what this wrote and rebuilds.
 *
 * Why it replays rather than building once: §3.6 places a transaction in the
 * month it *enters* the chain, not the date it claims. Writing every post up
 * front and building once would clamp all of them into a single open block —
 * one fat month instead of a history, with no size split, no silent month and
 * no amendment. So each round writes that month's posts, then builds with that
 * month's clock, exactly as authoring over time would have done.
 *
 * The lock is deleted first because sealed blocks are frozen: the existing
 * chain cannot grow a March block once its genesis is in June. Everything is
 * rebuilt from the post files, demo and real alike.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ASSETS, DEMO_DRAFTS, DEMO_ROUNDS, demoPaths, postFile } from './demo-content';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(ROOT, 'chain.lock.json');
const PENDING = join(ROOT, 'chain.pending.json');

function build(now: string): string {
  return execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/build-chain.ts', `--now=${now}`],
    { cwd: ROOT, encoding: 'utf8' },
  );
}

function line(out: string, key: string): string {
  const m = new RegExp(`^\\s*${key}\\s+(.*)$`, 'm').exec(out);
  return m === null ? '' : m[1]!.trim();
}

const mode = process.argv[2] === '--clear' ? 'clear' : 'seed';

if (mode === 'clear') {
  let removed = 0;
  for (const rel of demoPaths()) {
    const path = join(ROOT, rel);
    if (existsSync(path)) {
      rmSync(path);
      removed += 1;
    }
  }
  rmSync(LOCK, { force: true });
  rmSync(PENDING, { force: true });
  build('2026-08-03');
  console.log(`\n  removed     ${removed} demo file(s)`);
  console.log('  chain       rebuilt from the posts that remain');
  console.log('  next        npm run build\n');
} else {
  if (demoPaths().some((rel) => existsSync(join(ROOT, rel)))) {
    console.error('Demo content is already present. Run `npm run demo:clear` first.');
    process.exit(1);
  }

  // Assets and drafts exist for the whole run: an asset must be on disk before
  // the post referencing it is hashed, and drafts never touch the chain at all.
  mkdirSync(join(ROOT, 'content/assets'), { recursive: true });
  mkdirSync(join(ROOT, 'content/drafts'), { recursive: true });
  for (const a of DEMO_ASSETS) writeFileSync(join(ROOT, 'content/assets', a.file), `${a.svg}\n`);
  for (const d of DEMO_DRAFTS) {
    writeFileSync(
      join(ROOT, 'content/drafts', `${d.slug}.md`),
      `---\ntitle: ${JSON.stringify(d.title)}\ndate: ${d.date}\ntags: []\n---\n\nĐang viết dở.\n`,
    );
  }

  // Posts that were already here get held back and reintroduced at the round
  // whose clock has reached their own date. Without this they are on disk for
  // the very first build, and §3.6 clamps a future-dated post into the current
  // open month — so a post dated June lands in the March block. That is correct
  // engine behaviour and exactly wrong for a preview, since the block would
  // then show a date months ahead of its own period.
  const demoSlugs = new Set(DEMO_ROUNDS.flatMap((r) => r.posts.map((post) => post.slug)));
  const held = new Map<string, string>();
  for (const name of readdirSync(join(ROOT, 'content/posts'))) {
    if (!name.endsWith('.md')) continue;
    if (demoSlugs.has(name.slice(0, -3))) continue;
    const path = join(ROOT, 'content/posts', name);
    held.set(name, readFileSync(path, 'utf8'));
    rmSync(path);
  }

  /** Restores every held post, whatever happens — these are the author's own. */
  const restoreHeld = (): void => {
    for (const [name, raw] of held) {
      const path = join(ROOT, 'content/posts', name);
      if (!existsSync(path)) writeFileSync(path, raw);
    }
  };
  process.on('exit', restoreHeld);
  process.on('SIGINT', () => {
    restoreHeld();
    process.exit(130);
  });

  rmSync(LOCK, { force: true });
  rmSync(PENDING, { force: true });

  console.log('');
  console.log('  note        a replay deletes the pending record whenever a month is silent,');
  console.log('              so the build after 2026-05 warns that it cannot tell new work');
  console.log('              from a lost record. Expected here; it is real when you see it');
  console.log('              during ordinary authoring.\n');
  if (held.size > 0) {
    console.log(`  holding     ${held.size} existing post(s), each reintroduced in its own month\n`);
  }
  for (const round of DEMO_ROUNDS) {
    for (const post of round.posts) {
      writeFileSync(join(ROOT, 'content/posts', `${post.slug}.md`), postFile(post));
    }

    // Reintroduce any held post whose own date this round has reached.
    for (const [name, raw] of held) {
      const path = join(ROOT, 'content/posts', name);
      if (existsSync(path)) continue;
      const date = /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(raw)?.[1];
      if (date !== undefined && date <= round.now) writeFileSync(path, raw);
    }

    if (round.amend !== undefined) {
      const path = join(ROOT, 'content/posts', `${round.amend.slug}.md`);
      let raw = readFileSync(path, 'utf8');
      if (round.amend.title !== undefined) {
        raw = raw.replace(/^title: .*$/m, `title: ${JSON.stringify(round.amend.title)}`);
      }
      if (round.amend.research !== undefined) {
        raw = raw.replace(/^research: .*$/m, `research: ${round.amend.research.toFixed(1)}`);
      }
      if (round.amend.appendBody !== undefined) raw += round.amend.appendBody;
      writeFileSync(path, raw);
    }

    const out = build(round.now);
    const sealed = line(out, 'sealed');
    const pending = line(out, 'pending');
    console.log(`  ${round.now}  ${round.note}`);
    console.log(
      `              ${sealed || '0 new block(s)'}` +
        (pending === '' ? '' : `, ${pending}`) +
        (line(out, 'amendments') === '' ? '' : `, ${line(out, 'amendments')}`),
    );
  }

  const chain = JSON.parse(readFileSync(LOCK, 'utf8')) as {
    blocks: { height: number; period: string; transactions: unknown[] }[];
    assets: unknown[];
  };
  console.log('\n  chain');
  for (const b of chain.blocks) {
    console.log(`    #${String(b.height).padEnd(2)} ${b.period}  ${b.transactions.length} txn(s)`);
  }
  console.log(`    assets  ${chain.assets.length} token(s)`);
  console.log(`    drafts  ${DEMO_DRAFTS.length} (mempool — never on the chain)`);
  console.log('\n  next    npm run build   (or npm run dev)');
  console.log('  undo    npm run demo:clear\n');
}
