import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxRepo, buildSandbox, chainBuildSandbox, pendingIdsIn } from './sandbox';

/**
 * The stats bar states one rule and every tile follows it.
 *
 * It used to mix chain states: `Transactions` counted sealed blocks only while
 * the `Addresses` tile came from `addressIndex()`, which includes the open
 * block. Two numbers describing one chain disagreed, on the same row, with
 * nothing on the page explaining why.
 *
 * These drive a sandbox with a real pending transaction, because the live repo
 * has none — asserting against it would compare zero to zero and pass however
 * the rule were written. That is the shape that has slipped through here before.
 */
function tile(html: string, label: string): number {
  const re = new RegExp(`<div class="k">${label}</div>\\s*<div class="v">([^<]*)</div>`);
  const m = re.exec(html);
  if (m === null) throw new Error(`no "${label}" tile in the built homepage`);
  return Number(m[1]);
}

describe('stats bar consistency', () => {
  it('counts a pending transaction in Transactions, as Addresses already does', () => {
    const dir = sandboxRepo();
    writeFileSync(
      join(dir, 'content/posts/2026-08-02-tam.md'),
      '---\ntitle: Bài đang chờ\ndate: 2026-08-02\ntags: [tam-thoi]\nresearch: 2.0\n---\n\nMột hai ba.\n',
    );

    const sealedOnly = (() => {
      const before = chainBuildSandbox(dir, '2026-08-03');
      expect(before.status, before.output).toBe(0);
      const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
        blocks: { transactions: unknown[] }[];
      };
      return lock.blocks.reduce((n, b) => n + b.transactions.length, 0);
    })();

    // Whatever else is unsealed here — the author may have published this month
    // and committed `chain.pending.json`, which the sandbox copies — the
    // fixture post is one of them. Counting "+1" instead measured how much of
    // the author's own work was still in the open block.
    const open = pendingIdsIn(dir);
    expect(open, 'the fixture post did not land in the open block').toContain('2026-08-02-tam');

    const built = buildSandbox(dir);
    expect(built.status, built.output).toBe(0);
    const html = readFileSync(join(dir, 'dist/index.html'), 'utf8');

    // The open block's transactions are not in the lock — so a sealed-only
    // count would report `sealedOnly`, which is strictly less.
    expect(tile(html, 'Transactions')).toBe(sealedOnly + open.length);
    expect(
      tile(html, 'Transactions'),
      'the tile counted the sealed blocks alone and ignored the open one',
    ).toBeGreaterThan(sealedOnly);

    // And both tiles must describe the SAME chain state. Not a magnitude
    // comparison — one post sends to several tags and the identity is an
    // address too, so Addresses legitimately exceeds Transactions. The real
    // invariant is that the pending post is counted by both: its tag has an
    // address page, and the Transactions tile counted the post itself above.
    expect(existsSync(join(dir, 'dist/address/tam-thoi.tag/index.html'))).toBe(true);
    // Each of these drives `chain:build` and a full `astro build` in a sandbox
    // copy; vitest's 5s default is not close to enough.
  }, 60_000);

  it('keeps Chain height on the sealed tip, because a height is minted not predicted', () => {
    // The deliberate exception to the rule above: the open block's height is a
    // prediction a size-split could still change.
    const dir = sandboxRepo();
    writeFileSync(
      join(dir, 'content/posts/2026-08-02-tam.md'),
      '---\ntitle: Bài đang chờ\ndate: 2026-08-02\ntags: [tam-thoi]\n---\n\nMột hai ba.\n',
    );
    expect(chainBuildSandbox(dir, '2026-08-03').status).toBe(0);
    const lock = JSON.parse(readFileSync(join(dir, 'chain.lock.json'), 'utf8')) as {
      blocks: { height: number }[];
    };
    const tip = lock.blocks.reduce((max, b) => Math.max(max, b.height), 0);

    const built = buildSandbox(dir);
    expect(built.status, built.output).toBe(0);
    expect(tile(readFileSync(join(dir, 'dist/index.html'), 'utf8'), 'Chain height')).toBe(tip);
  }, 60_000);
});
