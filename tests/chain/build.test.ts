import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildChain, type BuildResult } from '../../src/chain/build';
import { verifyChain } from '../../src/chain/verify';
import { serializeChain } from '../../src/chain/lock';
import type { Transaction } from '../../src/chain/types';

/**
 * §3.6 — an edit enters the chain in the open month, so it lands in the
 * pending block and seals once that month has ended. `BuildResult.amendments`
 * counts only what *sealed*, so these read the amendment wherever it is now.
 */
function pendingAmendments(r: BuildResult): Transaction[] {
  return (r.pending?.transactions ?? []).filter((t) => t.type === 'amendment');
}

function sealedAmendments(r: BuildResult): Transaction[] {
  return r.chain.blocks.flatMap((b) => b.transactions).filter((t) => t.type === 'amendment');
}

const CONFIG = { difficulty: 2, maxTxPerBlock: 4, authorHandle: 'lamter', authorName: 'lamter.eth' };

function workspace(): { postsDir: string; assetsDir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chain-build-'));
  const postsDir = join(dir, 'posts');
  const assetsDir = join(dir, 'assets');
  cpSync('tests/fixtures/posts', postsDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  return { postsDir, assetsDir, lockPath: join(dir, 'chain.lock.json') };
}

describe('buildChain', () => {
  it('seals past months and mints empty blocks for silent ones', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    expect(chain.blocks.map((b) => b.period)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(chain.blocks[0]!.txCount).toBe(2);
    expect(chain.blocks[1]!.txCount).toBe(1);
    expect(chain.blocks[2]!.txCount).toBe(0);
  });

  it('produces a chain that verifies', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect((await verifyChain(chain)).ok).toBe(true);
  });

  it('starts genesis at height 0 with a zero prev hash', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(chain.blocks[0]!.height).toBe(0);
    expect(chain.blocks[0]!.prevHash).toBe('0x' + '00'.repeat(32));
  });

  it('sums gas and value per block', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(chain.blocks[0]!.value).toBe(14.5);
    expect(chain.blocks[2]!.gasUsed).toBe(0);
  });

  it('is byte-identical when re-run at the same clock', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    // §3.2b — the registry is serialized too, so determinism must be pinned
    // with at least one minted token present. On an asset-free workspace this
    // test could not have caught an unstable `assets` array at all.
    writeFileSync(join(assetsDir, 'a.svg'), 'A');
    writeFileSync(
      join(postsDir, '2026-07-20-hinh-xac-dinh.md'),
      '---\ntitle: "Hình"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![a](/assets/a.svg)\n',
    );
    const first = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(first.chain.assets).toHaveLength(1);
    const second = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(serializeChain(second.chain)).toBe(serializeChain(first.chain));
    expect(second.minted).toBe(0);
  });

  it('never rewrites a sealed block when the clock advances', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(after.chain.blocks.slice(0, 3)).toEqual(before.chain.blocks);
    expect(after.chain.blocks.map((b) => b.period)).toEqual([
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ]);
    expect(after.minted).toBe(2);
  });

  it('emits an amendment when a sealed post is edited', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const originalHash = before.chain.blocks[0]!.transactions[0]!.hash;

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');

    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    // The edit entered the chain in the open month, so it waits in the pending
    // block rather than sealing into 2026-10, a month that already closed.
    expect(after.amendments).toBe(0);
    expect(after.pending!.period).toBe('2026-11');

    const amendments = pendingAmendments(after);
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
    const { postsDir, assetsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const originalHash = before.chain.blocks[0]!.transactions[0]!.hash;

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(
      target,
      readFileSync(target, 'utf8').replace('Bài viết đầu tiên', 'Bài viết đầu tiên (sửa)'),
    );

    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(after.amendments).toBe(0);

    const amendment = pendingAmendments(after)[0]!;
    expect(amendment.amends).toBe(originalHash);
    expect(amendment.title).toBe('Bài viết đầu tiên (sửa)');
    expect(amendment.contentHash).toBe(before.chain.blocks[0]!.transactions[0]!.contentHash);
    expect(after.chain.blocks[0]).toEqual(before.chain.blocks[0]);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('emits an amendment for a research-only edit, carrying the new figure', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8').replace('research: 2.0', 'research: 6.5'));

    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(after.amendments).toBe(0);

    const amendment = pendingAmendments(after)[0]!;
    expect(amendment.research).toBe(6.5);
    // The hours are declared as metadata but not re-charged: they were already
    // counted in the block that sealed the original.
    expect(amendment.value).toBe(0);

    // And once its recorded month has ended the block seals still charging
    // nothing — the guarantee is about the sealed block, so check it there.
    const sealed = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(sealed.amendments).toBe(1);
    const amendmentBlock = sealed.chain.blocks.find((b) =>
      b.transactions.some((t) => t.type === 'amendment'),
    )!;
    expect(amendmentBlock.value).toBe(0);
    expect(amendmentBlock.period).toBe('2026-11');
    expect((await verifyChain(sealed.chain)).ok).toBe(true);
  });

  it('does not re-emit a metadata amendment on a subsequent unchanged build', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8').replace('tags: [essay]', 'tags: [essay, meta]'));
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    // The pending amendment's recorded month has now ended, so this build is
    // where it seals. What must not happen is a *second* amendment for the
    // same edit, now or on any later build.
    const third = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(sealedAmendments(third)).toHaveLength(1);
    expect(third.pending).toBeNull();

    const fourth = await buildChain({ postsDir, assetsDir, lockPath, now: '2027-01-10', config: CONFIG });
    expect(fourth.amendments).toBe(0);
    expect(sealedAmendments(fourth)).toHaveLength(1);
    expect(pendingAmendments(fourth)).toHaveLength(0);
  });

  it('emits exactly one amendment per successive distinct metadata edit', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');

    // Each edit is allowed to seal before the next is made, so both are
    // confirmed history and both must be recorded.
    writeFileSync(target, readFileSync(target, 'utf8').replace('đầu tiên"', 'đầu tiên (v2)"'));
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    const sealV2 = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(sealV2.amendments).toBe(1);

    writeFileSync(target, readFileSync(target, 'utf8').replace('(v2)"', '(v3)"'));
    await buildChain({ postsDir, assetsDir, lockPath, now: '2027-01-10', config: CONFIG });
    const sealV3 = await buildChain({ postsDir, assetsDir, lockPath, now: '2027-02-10', config: CONFIG });
    expect(sealV3.amendments).toBe(1);

    const amendments = sealedAmendments(sealV3);
    expect(amendments).toHaveLength(2);
    expect(amendments.map((t) => t.title)).toEqual([
      'Bài viết đầu tiên (v2)',
      'Bài viết đầu tiên (v3)',
    ]);
    expect(new Set(amendments.map((t) => t.hash)).size).toBe(2);
    expect((await verifyChain(sealV3.chain)).ok).toBe(true);
  });

  it('collapses successive edits made while the amendment is still pending', async () => {
    // An unconfirmed transaction can still be replaced. Editing again before
    // the open block seals supersedes the pending amendment rather than
    // stacking a second one, so the chain records the state that was actually
    // confirmed — not every intermediate keystroke.
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');

    writeFileSync(target, readFileSync(target, 'utf8').replace('đầu tiên"', 'đầu tiên (v2)"'));
    const second = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(pendingAmendments(second).map((t) => t.title)).toEqual(['Bài viết đầu tiên (v2)']);

    writeFileSync(target, readFileSync(target, 'utf8').replace('(v2)"', '(v3)"'));
    const third = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(pendingAmendments(third).map((t) => t.title)).toEqual(['Bài viết đầu tiên (v3)']);
    expect(sealedAmendments(third)).toHaveLength(0);

    const fourth = await buildChain({ postsDir, assetsDir, lockPath, now: '2027-01-10', config: CONFIG });
    const sealed = sealedAmendments(fourth);
    expect(sealed.map((t) => t.title)).toEqual(['Bài viết đầu tiên (v3)']);
    expect((await verifyChain(fourth.chain)).ok).toBe(true);
  });

  it('refuses a reused filename carrying a different date', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    // Same file name, different post: recording this as an amendment would
    // attach it to an unrelated sealed transaction.
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8').replace('date: 2026-06-15', 'date: 2026-09-02'));

    await expect(
      buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG }),
    ).rejects.toThrow(/2026-06-15-first\.md.*2026-06-15.*2026-09-02/s);
  });

  it('replaces the post with the amendment in the new block, not alongside it', async () => {
    // Regression: an edited post has a new contentHash, hence a new tx
    // hash, so filtering pending work on hash alone let the edited post
    // slip back in as a fresh "post" transaction sealed next to its own
    // amendment — duplicating the post on the chain.
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    // The open block holds the amendment alone — not the amendment plus a
    // fresh "post" transaction for the same slug.
    expect(after.pending!.transactions).toHaveLength(1);
    expect(after.pending!.transactions[0]!.type).toBe('amendment');

    // And it stays alone once it seals.
    const sealed = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    const amendmentBlock = sealed.chain.blocks.find((b) =>
      b.transactions.some((t) => t.type === 'amendment'),
    )!;
    expect(amendmentBlock.txCount).toBe(1);
    expect(amendmentBlock.transactions[0]!.type).toBe('amendment');
  });

  it('never carries two post transactions for the same slug', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    const postSlugs = after.chain.blocks
      .flatMap((b) => b.transactions)
      .filter((t) => t.type === 'post')
      .map((t) => t.slug);
    expect(new Set(postSlugs).size).toBe(postSlugs.length);
  });

  it('does not compound: a second distinct edit yields exactly one further amendment', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');

    // Each edit is sealed before the next is made, so both are confirmed and
    // the question is whether the second one *compounds* — re-emitting the
    // first alongside it, or re-publishing the post itself.
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });

    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa khác.\n');
    await buildChain({ postsDir, assetsDir, lockPath, now: '2027-01-10', config: CONFIG });
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2027-02-10', config: CONFIG });

    expect(after.amendments).toBe(1);
    const postSlugs = after.chain.blocks
      .flatMap((b) => b.transactions)
      .filter((t) => t.type === 'post')
      .map((t) => t.slug);
    expect(new Set(postSlugs).size).toBe(postSlugs.length);
    expect(sealedAmendments(after)).toHaveLength(2);
  });

  it('ignores a pending file recorded against a different tip', async () => {
    // The recorded period is only meaningful relative to the tip it was
    // recorded against. If the lock was rebuilt, reverted or replaced, that
    // placement was chosen for a history this chain no longer has — honouring
    // it would seal a transaction into a month picked for a different chain.
    const { postsDir, assetsDir, lockPath } = workspace();
    const pendingPath = join(dirname(lockPath), 'chain.pending.json');
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const pendingBuild = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(pendingBuild.pending!.period).toBe('2026-11');

    // Same file, but recorded against a tip this chain does not have.
    const onDisk = JSON.parse(readFileSync(pendingPath, 'utf8'));
    onDisk.prevHash = '0x' + 'e'.repeat(64);
    writeFileSync(pendingPath, JSON.stringify(onDisk, null, 2) + '\n');

    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    // Ignored, so the amendment is placed afresh in the open month rather than
    // sealing into the stale file's 2026-11.
    expect(after.amendments).toBe(0);
    expect(after.pending!.period).toBe('2026-12');
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('does not re-charge gas or research hours for an edited post', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    // The original block's totals — sealed before the edit — must be unchanged
    // the moment the amendment is created, before it has sealed anywhere.
    expect(after.chain.blocks[0]).toEqual(before.chain.blocks[0]);

    const sealed = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    const amendmentBlock = sealed.chain.blocks.find((b) =>
      b.transactions.some((t) => t.type === 'amendment'),
    )!;
    // The amendment itself carries no gas/value (asserted elsewhere); the
    // original post's numbers must not be re-summed into this block.
    expect(amendmentBlock.gasUsed).toBe(0);
    expect(amendmentBlock.value).toBe(0);
    expect(sealed.chain.blocks[0]).toEqual(before.chain.blocks[0]);
  });

  it('leaves the original transaction untouched after an amendment', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    expect(after.chain.blocks[0]).toEqual(before.chain.blocks[0]);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('does not re-emit an amendment on a subsequent unchanged build', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const target = join(postsDir, '2026-06-15-first.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nMột dòng sửa lại.\n');
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    // 2026-12 seals the pending amendment; 2027-01 must add nothing further.
    const third = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(sealedAmendments(third)).toHaveLength(1);
    const fourth = await buildChain({ postsDir, assetsDir, lockPath, now: '2027-01-10', config: CONFIG });
    expect(fourth.amendments).toBe(0);
    expect(sealedAmendments(fourth)).toHaveLength(1);
  });

  it('does not re-mint an empty block for an already-sealed month', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    const periods = after.chain.blocks.map((b) => b.period);
    expect(new Set(periods).size).toBe(periods.length);
  });

  it('places a backdated post in the first open period, not its own month', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    writeFileSync(
      join(postsDir, '2026-06-01-backdated.md'),
      '---\ntitle: "Bài viết lùi ngày"\ndate: 2026-06-01\ntags: [essay]\n---\n\nMột bài viết thêm sau.\n',
    );

    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    // Sealed history is untouched: the backdated post joins the OPEN month.
    expect(after.chain.blocks).toEqual(before.chain.blocks);
    // §3.6 — membership is when it entered the chain, which is 2026-09, not
    // its own 2026-06 and not the already-sealed tip month 2026-08.
    expect(after.pending!.period).toBe('2026-09');
    expect(after.pending!.transactions.map((t) => t.slug)).toEqual(['2026-06-01-backdated']);

    // Once 2026-09 has ended it seals there, still carrying its own date.
    const sealed = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-10-05', config: CONFIG });
    const block = sealed.chain.blocks.find((b) =>
      b.transactions.some((t) => t.slug === '2026-06-01-backdated'),
    )!;
    expect(block.period).toBe('2026-09');
    expect(block.transactions[0]!.date).toBe('2026-06-01');
    // Block periods never decrease along the chain.
    const periods = sealed.chain.blocks.map((b) => b.period);
    expect([...periods].sort()).toEqual(periods);
    expect((await verifyChain(sealed.chain)).ok).toBe(true);
  });

  it('refuses to extend a lock file that fails verification', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const corrupt = JSON.parse(readFileSync(lockPath, 'utf8'));
    corrupt.blocks[0].gasUsed = 999999;
    writeFileSync(lockPath, JSON.stringify(corrupt, null, 2));

    await expect(
      buildChain({ postsDir, assetsDir, lockPath, now: '2026-10-10', config: CONFIG }),
    ).rejects.toThrow(/refusing to extend/);
  });

  it('keeps building when the configured difficulty is lowered', async () => {
    // §3.6 — changing difficulty affects only new blocks. Verification checks
    // each block against the target committed in its own header, and the
    // chain-level value is only a floor, so a looser config neither
    // invalidates the sealed blocks nor blocks the build.
    const { postsDir, assetsDir, lockPath } = workspace();
    const before = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const looser = { ...CONFIG, difficulty: 1 };
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: looser });

    expect(after.chain.blocks.slice(0, 3)).toEqual(before.chain.blocks);
    expect(after.chain.blocks.slice(3).every((b) => b.difficulty === 1)).toBe(true);
    expect(after.chain.difficulty).toBe(1);
    expect((await verifyChain(after.chain)).ok).toBe(true);
  });

  it('keeps building when the configured difficulty is raised', async () => {
    // The floor only ever moves down: raising it would otherwise retroactively
    // invalidate every block sealed under the old target and brick the ledger.
    const { postsDir, assetsDir, lockPath } = workspace();
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const harder = { ...CONFIG, difficulty: 3 };
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: harder });

    expect(after.chain.blocks.slice(3).every((b) => b.difficulty === 3)).toBe(true);
    expect(after.chain.difficulty).toBe(2);
    expect((await verifyChain(after.chain)).ok).toBe(true);

    // And the next run still starts: the stored floor matches what is sealed.
    const again = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: harder });
    expect((await verifyChain(again.chain)).ok).toBe(true);
  });

  it('does not seal a future-dated post into its own month, and keeps minting after', async () => {
    // Verified failure: four posts dated 2027-03 sealed a block with period
    // 2027-03, after which fromPeriod was 2027-03 — neither past nor full —
    // and no block could ever be minted again until real time reached 2027.
    const { postsDir, assetsDir, lockPath } = workspace();
    for (const day of ['01', '02', '03', '04']) {
      writeFileSync(
        join(postsDir, `2027-03-${day}-future.md`),
        `---\ntitle: "Bài viết tương lai ${day}"\ndate: 2027-03-${day}\ntags: [essay]\n---\n\nMột bài viết trong tương lai.\n`,
      );
    }

    const first = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(first.chain.blocks.every((b) => b.period <= '2026-09')).toBe(true);
    const futureBlock = first.chain.blocks.find((b) =>
      b.transactions.some((t) => t.date.startsWith('2027-03')),
    )!;
    expect(futureBlock.period).toBe('2026-09');

    // The chain is not frozen: the next elapsed month still mints.
    const second = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    expect(second.minted).toBeGreaterThan(0);
    expect(second.chain.blocks.map((b) => b.period)).toContain('2026-10');
    expect((await verifyChain(second.chain)).ok).toBe(true);
  });

  it('matches the golden snapshot at a pinned clock', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    expect(serializeChain(chain)).toMatchSnapshot();
  });

  it('does not persist a chain that fails its own post-build verification', async () => {
    // §10 — writeLock must never run against a result buildChain itself knows
    // is broken: the corrupt chain would be persisted and the *next* run would
    // hit the pre-append guard and refuse to start at all, requiring a manual
    // revert to recover. The miner is stubbed to return a hash that is not the
    // header's, which is the shape of any bug producing an invalid block.
    const { postsDir, assetsDir, lockPath } = workspace();
    vi.resetModules();
    vi.doMock('../../src/chain/mine', () => ({
      meetsDifficulty: () => true,
      mine: () => ({ nonce: 0, hash: '0x' + '0'.repeat(64) }),
    }));
    try {
      const { buildChain: buildWithBrokenMiner } = await import('../../src/chain/build');
      await expect(
        buildWithBrokenMiner({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG }),
      ).rejects.toThrow(/refusing to write/);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      vi.doUnmock('../../src/chain/mine');
      vi.resetModules();
    }
  });

  it('mints a token for a referenced asset', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'so-do.svg'), '<svg/>');
    writeFileSync(
      join(postsDir, '2026-07-20-hinh.md'),
      '---\ntitle: "Có hình"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![sơ đồ](/assets/so-do.svg)\n',
    );
    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    expect(chain.assets).toHaveLength(1);
    expect(chain.assets[0]!.tokenId).toBe(1);
    expect(chain.assets[0]!.file).toBe('so-do.svg');
    expect(chain.assets[0]!.mime).toBe('image/svg+xml');
    expect(chain.assets[0]!.mintedIn).toBe(1);
    const tx = chain.blocks.flatMap((b) => b.transactions).find((t) => t.slug === '2026-07-20-hinh');
    expect(tx!.assets).toEqual([chain.assets[0]!.hash]);
  });

  it('assigns token ids by first appearance and never reassigns them', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'a.svg'), 'A');
    writeFileSync(
      join(postsDir, '2026-07-20-one.md'),
      '---\ntitle: "Một"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![a](/assets/a.svg)\n',
    );
    const first = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });
    const tokenOne = first.chain.assets[0]!;

    writeFileSync(join(assetsDir, 'b.svg'), 'B');
    writeFileSync(
      join(postsDir, '2026-09-05-two.md'),
      '---\ntitle: "Hai"\ndate: 2026-09-05\ntags: [cp]\n---\n\n![b](/assets/b.svg)\n',
    );
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });
    // A token is minted by first appearance in a *sealed* block, so the second
    // post must seal before its asset has an identity.
    const second = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });

    expect(second.chain.assets[0]).toEqual(tokenOne);
    expect(second.chain.assets[1]!.tokenId).toBe(2);
    expect(second.chain.assets[1]!.file).toBe('b.svg');
  });

  it('emits an amendment when a referenced image is replaced', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'a.svg'), 'ORIGINAL');
    writeFileSync(
      join(postsDir, '2026-07-20-one.md'),
      '---\ntitle: "Một"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![a](/assets/a.svg)\n',
    );
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    writeFileSync(join(assetsDir, 'a.svg'), 'SWAPPED');
    const after = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG });

    // The swap is detected and lands in the open block; the new file's token
    // is minted only once that block seals.
    expect(pendingAmendments(after)).toHaveLength(1);
    expect(after.chain.assets).toHaveLength(1);

    const third = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-12-10', config: CONFIG });
    expect(third.amendments).toBe(1);
    expect(third.chain.assets).toHaveLength(2);
    expect((await verifyChain(third.chain)).ok).toBe(true);

    // The text-edit path already has a "does not re-emit on a subsequent
    // unchanged build" guard; the asset path stopped short of it. If this
    // regresses, the failure mode is an amendment emitted on every build
    // forever.
    const fourth = await buildChain({ postsDir, assetsDir, lockPath, now: '2027-01-10', config: CONFIG });
    expect(fourth.amendments).toBe(0);
    expect(sealedAmendments(fourth)).toHaveLength(1);
  });

  it('fails the build when a post references a missing asset', async () => {
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(
      join(postsDir, '2026-07-20-broken.md'),
      '---\ntitle: "Thiếu"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![x](/assets/khong-co.svg)\n',
    );
    await expect(
      buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG }),
    ).rejects.toThrow(/khong-co\.svg/);
  });

  it('leaves an unreferenced file off the chain entirely', async () => {
    // With only the unreferenced file present, `assets === []` holds even if
    // reference discovery is broken outright, so the assertion proved nothing
    // about discovery. Write both kinds and pin which one got minted.
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'unused.png'), 'nobody links to me');
    writeFileSync(join(assetsDir, 'used.svg'), 'referenced');
    writeFileSync(
      join(postsDir, '2026-07-20-dung.md'),
      '---\ntitle: "Dùng"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![u](/assets/used.svg)\n',
    );

    const { chain } = await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    expect(chain.assets).toHaveLength(1);
    expect(chain.assets[0]!.file).toBe('used.svg');
    expect(chain.assets.map((a) => a.file)).not.toContain('unused.png');
  });

  it('names the registry fault when the lock is inconsistent only there', async () => {
    // A hand-edited `tokenId` passes `readLock` (it is still a positive
    // integer) and then fails `verifyChain` with every block green. The guard
    // used to print an empty block list and no cause at all.
    const { postsDir, assetsDir, lockPath } = workspace();
    writeFileSync(join(assetsDir, 'a.svg'), 'A');
    writeFileSync(
      join(postsDir, '2026-07-20-mot.md'),
      '---\ntitle: "Một"\ndate: 2026-07-20\ntags: [cp]\n---\n\n![a](/assets/a.svg)\n',
    );
    await buildChain({ postsDir, assetsDir, lockPath, now: '2026-09-10', config: CONFIG });

    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.assets[0].tokenId = 7;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

    await expect(
      buildChain({ postsDir, assetsDir, lockPath, now: '2026-11-10', config: CONFIG }),
    ).rejects.toThrow(/asset registry: asset #0 has tokenId 7, expected 1/);
  });
});
