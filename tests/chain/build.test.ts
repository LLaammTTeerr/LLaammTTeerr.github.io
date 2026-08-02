import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChain } from '../../src/chain/build';
import { verifyChain } from '../../src/chain/verify';
import { serializeChain } from '../../src/chain/lock';

const CONFIG = { difficulty: 2, maxTxPerBlock: 4, authorHandle: 'lamter', authorName: 'lamter.eth' };

function workspace(): { postsDir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chain-build-'));
  const postsDir = join(dir, 'posts');
  cpSync('tests/fixtures/posts', postsDir, { recursive: true });
  return { postsDir, lockPath: join(dir, 'chain.lock.json') };
}

describe('buildChain', () => {
  it('seals past months and mints empty blocks for silent ones', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    expect(chain.blocks.map((b) => b.period)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(chain.blocks[0]!.txCount).toBe(2);
    expect(chain.blocks[1]!.txCount).toBe(1);
    expect(chain.blocks[2]!.txCount).toBe(0);
  });

  it('produces a chain that verifies', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect((await verifyChain(chain)).ok).toBe(true);
  });

  it('starts genesis at height 0 with a zero prev hash', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(chain.blocks[0]!.height).toBe(0);
    expect(chain.blocks[0]!.prevHash).toBe('0x' + '00'.repeat(32));
  });

  it('sums gas and value per block', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(chain.blocks[0]!.value).toBe(14.5);
    expect(chain.blocks[2]!.gasUsed).toBe(0);
  });

  it('is byte-identical when re-run at the same clock', async () => {
    const { postsDir, lockPath } = workspace();
    const first = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const second = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(serializeChain(second.chain)).toBe(serializeChain(first.chain));
    expect(second.minted).toBe(0);
  });

  it('never rewrites a sealed block when the clock advances', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(after.chain.blocks.slice(0, 3)).toEqual(before.chain.blocks);
    expect(after.chain.blocks.map((b) => b.period)).toEqual([
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(after.minted).toBe(2);
  });

  it('emits an amendment when a sealed post is edited', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const originalHash = before.chain.blocks[0]!.transactions[0]!.hash;

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');

    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(after.amendments).toBe(1);

    const amendments = after.chain.blocks.flatMap((b) =>
      b.transactions.filter((t) => t.type === 'amendment'),
    );
    expect(amendments).toHaveLength(1);
    expect(amendments[0]!.amends).toBe(originalHash);
    expect(amendments[0]!.gasUsed).toBe(0);
    expect(amendments[0]!.value).toBe(0);
    expect(amendments[0]!.date).toBe('2026-06-15');
    // §3.9 — the metadata fields carry the post's new declared state even when
    // only the body changed, so a renderer can read current state from the
    // latest amendment alone.
    expect(amendments[0]!.title).toBe('Bài viết đầu tiên');
    expect(amendments[0]!.research).toBe(2);
  });

  it('emits an amendment for a title-only edit', async () => {
    // The body — and therefore the content hash — is untouched. Detecting on
    // the content hash alone silently discarded metadata edits: no amendment,
    // no transaction, no warning, and a stale title on the chain forever.
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const originalHash = before.chain.blocks[0]!.transactions[0]!.hash;

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(
      target,
      readFileSync(target, 'utf8').replace('Bài viết đầu tiên', 'Bài viết đầu tiên (sửa)'),
    );

    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(after.amendments).toBe(1);

    const amendment = after.chain.blocks
      .flatMap((b) => b.transactions)
      .find((t) => t.type === 'amendment')!;
    expect(amendment.amends).toBe(originalHash);
    expect(amendment.title).toBe('Bài viết đầu tiên (sửa)');
    expect(amendment.contentHash).toBe(before.chain.blocks[0]!.transactions[0]!.contentHash);
    expect(after.chain.blocks[0]).toEqual(before.chain.blocks[0]);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('emits an amendment for a research-only edit, carrying the new figure', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8').replace('research: 2.0', 'research: 6.5'));

    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(after.amendments).toBe(1);

    const amendment = after.chain.blocks
      .flatMap((b) => b.transactions)
      .find((t) => t.type === 'amendment')!;
    expect(amendment.research).toBe(6.5);
    // The hours are declared as metadata but not re-charged: they were already
    // counted in the block that sealed the original.
    expect(amendment.value).toBe(0);
    const amendmentBlock = after.chain.blocks.find((b) =>
      b.transactions.some((t) => t.type === 'amendment'),
    )!;
    expect(amendmentBlock.value).toBe(0);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('does not re-emit a metadata amendment on a subsequent unchanged build', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8').replace('tags: [essay]', 'tags: [essay, meta]'));
    await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    const third = await buildChain({ postsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(third.amendments).toBe(0);
  });

  it('emits exactly one amendment per successive distinct metadata edit', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');

    writeFileSync(target, readFileSync(target, 'utf8').replace('đầu tiên"', 'đầu tiên (v2)"'));
    const second = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(second.amendments).toBe(1);

    writeFileSync(target, readFileSync(target, 'utf8').replace('(v2)"', '(v3)"'));
    const third = await buildChain({ postsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(third.amendments).toBe(1);

    const amendments = third.chain.blocks
      .flatMap((b) => b.transactions)
      .filter((t) => t.type === 'amendment');
    expect(amendments).toHaveLength(2);
    expect(amendments.map((t) => t.title)).toEqual([
      'Bài viết đầu tiên (v2)',
      'Bài viết đầu tiên (v3)',
    ]);
    expect(new Set(amendments.map((t) => t.hash)).size).toBe(2);
    expect((await verifyChain(third.chain)).ok).toBe(true);
  });

  it('refuses a reused filename carrying a different date', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    // Same file name, different post: recording this as an amendment would
    // attach it to an unrelated sealed transaction.
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8').replace('date: 2026-06-15', 'date: 2026-09-02'));

    await expect(
      buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG }),
    ).rejects.toThrow(/2026-06-15-first\.md.*2026-06-15.*2026-09-02/s);
  });

  it('replaces the post with the amendment in the new block, not alongside it', async () => {
    // Regression: an edited post has a new contentHash, hence a new tx
    // hash, so filtering pending work on hash alone let the edited post
    // slip back in as a fresh "post" transaction sealed next to its own
    // amendment — duplicating the post on the chain.
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    // The amendment's own block, not necessarily the last block on the
    // chain — a backdated-into-a-sealed-period amendment can be followed by
    // further, later, empty months (§3.6's own already-tested rule).
    const amendmentBlock = after.chain.blocks.find((b) =>
      b.transactions.some((t) => t.type === 'amendment'),
    )!;
    expect(amendmentBlock.txCount).toBe(1);
    expect(amendmentBlock.transactions[0]!.type).toBe('amendment');
  });

  it('never carries two post transactions for the same slug', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    const postSlugs = after.chain.blocks
      .flatMap((b) => b.transactions)
      .filter((t) => t.type === 'post')
      .map((t) => t.slug);
    expect(new Set(postSlugs).size).toBe(postSlugs.length);
  });

  it('does not compound: a second distinct edit yields exactly one further amendment', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');

    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa khác.\n');
    const after = await buildChain({ postsDir, lockPath, now: '2026-12-10', config: CONFIG });

    expect(after.amendments).toBe(1);
    const postSlugs = after.chain.blocks
      .flatMap((b) => b.transactions)
      .filter((t) => t.type === 'post')
      .map((t) => t.slug);
    expect(new Set(postSlugs).size).toBe(postSlugs.length);
    const amendmentCount = after.chain.blocks
      .flatMap((b) => b.transactions)
      .filter((t) => t.type === 'amendment').length;
    expect(amendmentCount).toBe(2);
  });

  it('does not re-charge gas or research hours for an edited post', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    const amendmentBlock = after.chain.blocks.find((b) =>
      b.transactions.some((t) => t.type === 'amendment'),
    )!;
    // The amendment itself carries no gas/value (asserted elsewhere); the
    // original post's numbers must not be re-summed into this block.
    expect(amendmentBlock.gasUsed).toBe(0);
    expect(amendmentBlock.value).toBe(0);
    // And the original block's totals — sealed before the edit — must be
    // unchanged.
    expect(after.chain.blocks[0]).toEqual(before.chain.blocks[0]);
  });

  it('leaves the original transaction untouched after an amendment', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(after.chain.blocks[0]).toEqual(before.chain.blocks[0]);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('does not re-emit an amendment on a subsequent unchanged build', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    const third = await buildChain({ postsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(third.amendments).toBe(0);
  });

  it('does not re-mint an empty block for an already-sealed month', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    const periods = after.chain.blocks.map((b) => b.period);
    expect(new Set(periods).size).toBe(periods.length);
  });

  it('places a backdated post in the first open period, not its own month', async () => {
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    writeFileSync(
      join(postsDir, '2026-06-01-backdated.md'),
      '---\ntitle: "Bài viết lùi ngày"\ndate: 2026-06-01\ntags: [essay]\n---\n\nMột bài viết thêm sau.\n',
    );

    const after = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(after.chain.blocks.slice(0, 3)).toEqual(before.chain.blocks);
    expect(after.chain.blocks).toHaveLength(4);
    expect(after.chain.blocks[3]!.transactions.map((t) => t.slug)).toEqual(['2026-06-01-backdated']);
    // §3.6 — membership is when it entered the chain. The post keeps its
    // 2026-06-01 date, but its block is the first period still open.
    expect(after.chain.blocks[3]!.period).toBe('2026-08');
    expect(after.chain.blocks[3]!.transactions[0]!.date).toBe('2026-06-01');
    // Block periods never decrease along the chain.
    const periods = after.chain.blocks.map((b) => b.period);
    expect([...periods].sort()).toEqual(periods);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('refuses to extend a lock file that fails verification', async () => {
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const corrupt = JSON.parse(readFileSync(lockPath, 'utf8'));
    corrupt.blocks[0].gasUsed = 999999;
    writeFileSync(lockPath, JSON.stringify(corrupt, null, 2));

    await expect(
      buildChain({ postsDir, lockPath, now: '2026-10-10', config: CONFIG }),
    ).rejects.toThrow(/refusing to extend/);
  });

  it('keeps building when the configured difficulty is lowered', async () => {
    // §3.6 — changing difficulty affects only new blocks. Verification checks
    // each block against the target committed in its own header, and the
    // chain-level value is only a floor, so a looser config neither
    // invalidates the sealed blocks nor blocks the build.
    const { postsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const looser = { ...CONFIG, difficulty: 1 };
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: looser });

    expect(after.chain.blocks.slice(0, 3)).toEqual(before.chain.blocks);
    expect(after.chain.blocks.slice(3).every((b) => b.difficulty === 1)).toBe(true);
    expect(after.chain.difficulty).toBe(1);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('keeps building when the configured difficulty is raised', async () => {
    // The floor only ever moves down: raising it would otherwise retroactively
    // invalidate every block sealed under the old target and brick the ledger.
    const { postsDir, lockPath } = workspace();
    await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const harder = { ...CONFIG, difficulty: 3 };
    const after = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: harder });

    expect(after.chain.blocks.slice(3).every((b) => b.difficulty === 3)).toBe(true);
    expect(after.chain.difficulty).toBe(2);
    expect((await verifyChain(after.chain)).ok).toBe(true);

    // And the next run still starts: the stored floor matches what is sealed.
    const again = await buildChain({ postsDir, lockPath, now: '2026-12-10', config: harder });
    expect((await verifyChain(again.chain)).ok).toBe(true);
  });

  it('does not seal a future-dated post into its own month, and keeps minting after', async () => {
    // Verified failure: four posts dated 2027-03 sealed a block with period
    // 2027-03, after which fromPeriod was 2027-03 — neither past nor full —
    // and no block could ever be minted again until real time reached 2027.
    const { postsDir, lockPath } = workspace();
    for (const day of ['01', '02', '03', '04']) {
      writeFileSync(
        join(postsDir, `2027-03-${day}-future.md`),
        `---\ntitle: "Bài viết tương lai ${day}"\ndate: 2027-03-${day}\ntags: [essay]\n---\n\nMột bài viết trong tương lai.\n`,
      );
    }

    const first = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(first.chain.blocks.every((b) => b.period <= '2026-09')).toBe(true);
    const futureBlock = first.chain.blocks.find((b) =>
      b.transactions.some((t) => t.date.startsWith('2027-03')),
    )!;
    expect(futureBlock.period).toBe('2026-09');

    // The chain is not frozen: the next elapsed month still mints.
    const second = await buildChain({ postsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(second.minted).toBeGreaterThan(0);
    expect(second.chain.blocks.map((b) => b.period)).toContain('2026-10');
    expect((await verifyChain(second.chain)).ok).toBe(true);
  });

  it('matches the golden snapshot at a pinned clock', async () => {
    const { postsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(serializeChain(chain)).toMatchSnapshot();
  });

  it('does not persist a chain that fails its own post-build verification', async () => {
    // §10 — writeLock must never run against a result buildChain itself knows
    // is broken: the corrupt chain would be persisted and the *next* run would
    // hit the pre-append guard and refuse to start at all, requiring a manual
    // revert to recover. The miner is stubbed to return a hash that is not the
    // header's, which is the shape of any bug producing an invalid block.
    const { postsDir, lockPath } = workspace();
    vi.resetModules();
    vi.doMock('../../src/chain/mine', () => ({
      meetsDifficulty: () => true,
      mine: () => ({ nonce: 0, hash: '0x' + '0'.repeat(64) }),
    }));
    try {
      const { buildChain: buildWithBrokenMiner } = await import('../../src/chain/build');
      await expect(
        buildWithBrokenMiner({ postsDir, lockPath, now: '2026-09-10', config: CONFIG }),
      ).rejects.toThrow(/refusing to write/);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      vi.doUnmock('../../src/chain/mine');
      vi.resetModules();
    }
  });
});
