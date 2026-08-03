import type { APIRoute } from 'astro';
import { ledgerBytes } from '../site/chain-data';

/**
 * §7 — the raw ledger, published for a reader to recompute.
 *
 * "`/verify` fetches `chain.json` and recomputes the chain in the reader's
 * browser." This is the file it fetches, and the reason the project's central
 * claim is checkable at all: a reader who does not trust a page that says
 * *verified* can take these bytes, hash them themselves, and find out.
 *
 * It serves the committed `chain.lock.json` **byte for byte** — see
 * `ledgerBytes`. Nothing here parses, filters, sorts or re-serialises the
 * ledger, and nothing should: the published document has to diff clean against
 * the file in the repository, or the two are not obviously the same ledger.
 *
 * The open block is not in it. Its transactions have real hashes but no mined
 * block, so a merged document is one `verifyChain` must reject — it lives at
 * `/chain.pending.json` instead.
 */
export const GET: APIRoute = () =>
  new Response(ledgerBytes(), {
    // A static host serves `dist/chain.json` by extension; this is the header
    // `astro dev` answers with, where the extension buys nothing.
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
