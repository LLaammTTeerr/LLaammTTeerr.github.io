/**
 * Verify the committed ledger, and say so in words.
 *
 * `npm run chain:verify` — reads `chain.lock.json` as it is committed and runs
 * the same `verifyChain` the browser runs on `/verify`: every block's hash
 * recomputed, every Merkle root recomputed, every link and every proof of work
 * rechecked, every transaction hash recomputed, and the asset registry checked
 * against first appearance.
 *
 * **This reads. It never writes, never mines and never touches the clock.** The
 * lock is committed history, not a build artifact — regenerating it here would
 * hash against whatever time this happened to run and rewrite blocks the whole
 * project treats as frozen. Mining lives in one place, and it is not this file.
 *
 * Why it exists at all, given that `npm test` verifies the chain and
 * `astro build` refuses a ledger that disagrees with `content/`: both of those
 * report the chain incidentally, inside hundreds of other assertions. This is
 * the project's central claim, and in a CI log it deserves a line that states
 * it by name — so that a reader asking "was the chain checked?" finds an answer
 * rather than an inference.
 */
import { existsSync } from 'node:fs';
import { CHAIN_CONFIG } from '../chain.config';
import { readLock } from '../src/chain/lock';
import { verifyChain } from '../src/chain/verify';

const LOCK = 'chain.lock.json';

/**
 * `readLock` answers a missing file with an *empty* chain — the right answer
 * for `chain:build`, which has to be able to mine a genesis block, and exactly
 * the wrong one here. An empty chain verifies: without this guard a repository
 * that had lost its ledger would get a confident `integrity OK` and a green
 * check, which is the worst possible output for a tool whose entire job is to
 * notice that the ledger is wrong.
 */
if (!existsSync(LOCK)) {
  console.error(`  ${LOCK} is not here — there is no ledger to verify.`);
  process.exit(1);
}

// Throws, with the offending index and field named, on a ledger too malformed
// to check at all. That is a verification failure like any other and it should
// stop whatever is running this.
const chain = readLock(LOCK, CHAIN_CONFIG.difficulty);

// The second half of the same guard. A lock file that parses to zero blocks is
// structurally valid and verifies vacuously; reporting it clean would say
// "the chain is intact" about a chain that is not there.
if (chain.blocks.length === 0) {
  console.error(`  ${LOCK} records no block — there is no history to verify.`);
  process.exit(1);
}

const result = await verifyChain(chain);
const txCount = chain.blocks.reduce((s, b) => s + b.txCount, 0);

console.log(`  ledger      ${LOCK}`);
console.log(`  height      ${chain.blocks.length}`);
console.log(`  txns        ${txCount}`);
console.log(`  assets      ${chain.assets.length}`);
console.log(`  difficulty  ${chain.difficulty}`);
console.log(`  integrity   ${result.ok ? 'OK' : 'FAILED'}`);

if (!result.ok) {
  // Reported in the same shape `scripts/build-chain.ts` reports it, so the two
  // read identically and whoever has seen one recognizes the other. The
  // registry line is separate because a registry-only failure has no failing
  // block to print — without it the operator gets the word FAILED and nothing
  // else.
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
