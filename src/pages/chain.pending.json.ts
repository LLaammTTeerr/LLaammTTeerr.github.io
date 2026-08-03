import type { APIRoute } from 'astro';
import { openBlockBytes } from '../site/chain-data';

/**
 * §3.6 — the open block, published beside the ledger and never inside it.
 *
 * A pending transaction has a real hash, a page and an address, but no mined
 * block: no nonce, no `merkleRoot`, no header hash meeting the difficulty. Put
 * into `chain.json` it would make a document `verifyChain` is obliged to
 * reject, and a reader recomputing the chain would find the tip broken and
 * reasonably conclude the ledger was. Left out entirely it would be invisible,
 * and a reader who had just read a pending post on the site would find no
 * record of it in anything the site publishes.
 *
 * So it gets its own route, with its own bytes — the committed
 * `chain.pending.json`, unchanged, on exactly the rule `/chain.json` follows.
 * The two documents are joined by the open block's `prevHash`, which is the
 * ledger tip's hash: a verifier checks the chain from `chain.json`, then checks
 * that the open block still hangs off the tip it just verified and that each of
 * its transaction hashes recomputes. That is every check available before a
 * block is mined, and it is exactly what `src/chain/pending.ts` does here.
 *
 * When there is no open block the route is **absent** — `null` body, which
 * Astro's static build writes no file for, and a 404 in `astro dev`. Not an
 * empty file and not an invented empty-block document: a reader asking for an
 * open block the chain does not have must be told there is none, not handed a
 * document nothing in the repository backs.
 */
export const GET: APIRoute = () => {
  const bytes = openBlockBytes();
  if (bytes === null) return new Response(null, { status: 404 });
  return new Response(bytes, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
