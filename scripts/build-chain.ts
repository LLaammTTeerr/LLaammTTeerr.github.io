import { CHAIN_CONFIG } from '../chain.config';
import { buildChain } from '../src/chain/build';
import { verifyChain } from '../src/chain/verify';

/**
 * The clock enters the system here and nowhere else. `--now=YYYY-MM-DD`
 * overrides it, which is what makes reproducible builds possible.
 */
function resolveNow(argv: string[]): string {
  const flag = argv.find((a) => a.startsWith('--now='));
  if (flag) return flag.slice('--now='.length);
  return new Date().toISOString().slice(0, 10);
}

const now = resolveNow(process.argv.slice(2));

const { chain, minted, amendments } = await buildChain({
  postsDir: 'content/posts',
  lockPath: 'chain.lock.json',
  now,
  config: CHAIN_CONFIG,
});

const result = await verifyChain(chain);
const txCount = chain.blocks.reduce((s, b) => s + b.txCount, 0);

console.log(`  clock       ${now}`);
console.log(`  sealed      ${minted} new block(s)`);
if (amendments > 0) console.log(`  amendments  ${amendments} sealed post(s) edited`);
console.log(`  height      ${chain.blocks.length}`);
console.log(`  txns        ${txCount}`);
console.log(`  integrity   ${result.ok ? 'OK' : 'FAILED'}`);

if (!result.ok) {
  for (const b of result.blocks.filter((b) => !b.ok)) {
    console.error(
      `  block #${b.height}  hash:${b.hashOk} merkle:${b.merkleOk} link:${b.linkOk} pow:${b.powOk}`,
    );
  }
  process.exit(1);
}
