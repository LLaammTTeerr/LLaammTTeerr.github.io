import { CHAIN_CONFIG } from '../chain.config';
import { buildChain } from '../src/chain/build';
import { verifyChain } from '../src/chain/verify';
import { resolveNow } from './resolve-now';

let now: string;
try {
  now = resolveNow(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { chain, minted, amendments, pending, unrecorded } = await buildChain({
  postsDir: 'content/posts',
  assetsDir: 'content/assets',
  lockPath: 'chain.lock.json',
  now,
  config: CHAIN_CONFIG,
});

const result = await verifyChain(chain);
const txCount = chain.blocks.reduce((s, b) => s + b.txCount, 0);

console.log(`  clock       ${now}`);
console.log(`  sealed      ${minted} new block(s)`);
if (amendments > 0) console.log(`  amendments  ${amendments} sealed post(s) edited`);
if (pending !== null) {
  console.log(
    `  pending     ${pending.transactions.length} txn(s) in the open ${pending.period} block`,
  );
}
console.log(`  height      ${chain.blocks.length}`);
console.log(`  txns        ${txCount}`);
console.log(`  assets      ${chain.assets.length}`);
console.log(`  integrity   ${result.ok ? 'OK' : 'FAILED'}`);

// The open block lives in a second artifact. Committing chain.lock.json alone
// loses it, and losing it silently restores the sliding bug this design exists
// to remove — so say so every time one is written.
if (pending !== null) {
  console.log(`  →  chain.pending.json records the open ${pending.period} block; commit it beside chain.lock.json`);
}

// Deliberately claims nothing about *why* these have no record. The build has
// no memory of earlier runs, so it cannot tell a transaction created just now
// from one whose record was deleted — and a warning that asserts the wrong
// cause is worse than none, because it teaches the reader to discount it.
if (unrecorded.length > 0) {
  console.error('');
  console.error(
    `  WARNING  ${unrecorded.length} unsealed transaction(s) were placed with no record naming them:`,
  );
  for (const t of unrecorded) {
    console.error(`    ${t.type} ${t.slug ?? `amending ${t.amends}`}`);
  }
  console.error(
    '  This build cannot tell whether they are new or whether chain.pending.json was lost.\n' +
      '  If they are new, the record just written covers them from the next build on.\n' +
      '  If it was lost, their placement has been reassigned and the month they were\n' +
      '  waiting in may seal as an empty block. Committing chain.pending.json prevents this.',
  );
}

if (!result.ok) {
  // A registry-only failure has no failing block to print, so without this the
  // operator got the word FAILED and nothing else.
  if (result.registry !== undefined) {
    console.error(`  registry    ${result.registry}`);
  }
  for (const b of result.blocks.filter((b) => !b.ok)) {
    console.error(
      `  block #${b.height}  hash:${b.hashOk} merkle:${b.merkleOk} link:${b.linkOk} pow:${b.powOk} tx:${b.txOk}` +
        (b.reason === undefined ? '' : `  ${b.reason}`),
    );
  }
  process.exit(1);
}
