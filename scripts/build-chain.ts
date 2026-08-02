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

const { chain, minted, amendments } = await buildChain({
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
console.log(`  height      ${chain.blocks.length}`);
console.log(`  txns        ${txCount}`);
console.log(`  assets      ${chain.assets.length}`);
console.log(`  integrity   ${result.ok ? 'OK' : 'FAILED'}`);

if (!result.ok) {
  for (const b of result.blocks.filter((b) => !b.ok)) {
    console.error(
      `  block #${b.height}  hash:${b.hashOk} merkle:${b.merkleOk} link:${b.linkOk} pow:${b.powOk} tx:${b.txOk}` +
        (b.reason === undefined ? '' : `  ${b.reason}`),
    );
  }
  process.exit(1);
}
