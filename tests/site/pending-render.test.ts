import { it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxRepo, buildSandbox, chainBuildSandbox, pendingIdsIn } from './sandbox';
import { parseRules, selectorParts } from './css';
import { readDist } from './dist';

/**
 * The open block's visual treatment: `PendingState.astro`, and the branches
 * it drives in `BlockCard.astro` / `TxPanel.astro`.
 *
 * `sealedHtml()` reads the real, already-built `dist/` — every block on the
 * committed chain is sealed, so the homepage is a genuine sealed fixture with
 * no fabrication needed (matches `tests/site/homepage.test.ts`).
 *
 * `pendingHtml()` cannot come from the same source: nothing in the committed
 * repository has an open block, and no route yet renders one (that is a
 * later task's job). A throwaway page is written into a *sandboxed copy* of
 * the repo — never the real one — purely to give `astro build` something to
 * render `BlockCard`/`TxPanel` against with a real pending block produced by
 * a real `chain:build`. This still goes through the full build pipeline
 * (chain-data, layouts, the real stylesheet), so it is not rendering the
 * components in isolation — it is exercising the same wiring the other site
 * tests exercise, just against a fixture chain instead of the shipped one.
 */

let pendingHtmlCache: string;

beforeAll(() => {
  const dir = sandboxRepo();

  // A new post dated inside the still-open period. The real chain's tip is
  // 2026-07 (sealed, empty), so 2026-08 is the next open period and a build
  // clocked mid-August neither seals it (month not over) nor overflows it
  // (1 of 4 slots) — it stays pending.
  const post = [
    '---',
    'title: "Bai dang cho niem phong"',
    'date: 2026-08-10',
    'tags: [meta]',
    'research: 0.5',
    '---',
    '',
    'Noi dung cho bai viet dang cho.',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'content/posts/2026-08-10-bai-dang-cho.md'), post);

  // A throwaway route, written only into the sandbox copy, that renders the
  // two components under test against whatever `getPendingBlock()` finds.
  // Not part of the real site and never committed.
  const page = [
    '---',
    "import BlockCard from '../components/BlockCard.astro';",
    "import TxPanel from '../components/TxPanel.astro';",
    "import { getPendingBlock, resolvedPost } from '../site/chain-data';",
    '',
    'const pending = getPendingBlock();',
    'if (pending === null) {',
    "  throw new Error('sandbox fixture produced no pending block');",
    '}',
    "const post = resolvedPost('2026-08-10-bai-dang-cho');",
    'if (post === undefined) {',
    "  throw new Error('sandbox fixture pending block has no such post');",
    '}',
    '---',
    '<BlockCard block={pending} isNewest={true} isOldest={true} />',
    // The panel takes the resolution and nothing else — a `Transaction` is a
    // type error there, which is the point (see TxPanel's own doc). Nothing
    // amends this fixture, so the resolution is the pending post itself.
    '<TxPanel post={post} />',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'src/pages/pending-fixture.astro'), page);

  const chain = chainBuildSandbox(dir, '2026-08-20');
  if (chain.status !== 0) {
    throw new Error(`chain:build failed in the sandbox:\n${chain.output}`);
  }
  // Assert THIS fixture is pending, not that the open block holds exactly one
  // transaction: the sandbox inherits the repo's own chain.pending.json, so a
  // count would break the day the author publishes in the current month.
  if (!pendingIdsIn(dir).includes('2026-08-10-bai-dang-cho')) {
    throw new Error(
      `the fixture post did not land in the open block (pending: ${pendingIdsIn(dir).join(', ') || 'none'}):\n${chain.output}`,
    );
  }

  const build = buildSandbox(dir);
  if (build.status !== 0) {
    throw new Error(`sandbox build failed:\n${build.output}`);
  }

  pendingHtmlCache = readFileSync(join(dir, 'dist/pending-fixture/index.html'), 'utf8');
}, 120_000);

const pendingHtml = () => pendingHtmlCache;
const sealedHtml = () => readDist('index.html');

it('stamps a pending block differently from a sealed one', () => {
  expect(pendingHtml()).toContain('Chưa niêm phong');
  expect(pendingHtml()).not.toContain('Sealed');
  expect(sealedHtml()).toContain('Sealed');
});

it('shows no hash or nonce for a block that has not been mined', () => {
  // Not merely absent — explicitly marked, so a reader is not left wondering
  // whether the site failed to load it.
  expect(pendingHtml()).toContain('chưa có, khối chưa đào');
  expect(pendingHtml()).not.toMatch(/nonce/i);
});

it('marks a pending transaction hash as provisional', () => {
  expect(pendingHtml()).toContain('<span class="tilde">~</span>');
});

/**
 * The five rules that colour the unsealed state. Named so the guard below
 * cannot quietly stop covering them: the previous version sliced the
 * stylesheet from `.c-state` and so scanned only the last of these, and a
 * literal `#ff9900` in `.stamp.open` passed it — the unsealed stamp would
 * have been orange under all eleven palettes.
 */
const PENDING_STATE_RULES = ['.a-hash', '.a-hash .tilde', '.stamp.open', '.gutter .dot.open', '.c-state'];

it('uses no hard-coded colour anywhere in the chain stylesheet', () => {
  const css = readFileSync('src/styles/chain.css', 'utf8');
  const rules = parseRules(css);
  expect(rules.length, 'chain.css parsed to no rules at all').toBeGreaterThan(0);

  // Anti-vacuity, and the reason this scans whole rules rather than a slice:
  // a rename or a reorder must break the guard loudly, not silently shrink
  // what it covers (the old `indexOf` returned -1 and scanned one character).
  const selectors = new Set(rules.flatMap(selectorParts));
  for (const rule of PENDING_STATE_RULES) {
    expect(selectors.has(rule), `${rule} is not a rule in chain.css — the guard is not scanning it`).toBe(true);
  }

  // Global Constraint: eleven reader-selectable palettes, so every colour goes
  // through a token. Checked over every declaration block in the file, not
  // over the pending rules alone — a literal is just as wrong in a sealed one.
  for (const rule of rules) {
    expect(rule.body, `${rule.selector} hard-codes a colour instead of using a token`).not.toMatch(
      /#[0-9a-f]{3,8}\b|rgba?\(/i,
    );
  }
});
