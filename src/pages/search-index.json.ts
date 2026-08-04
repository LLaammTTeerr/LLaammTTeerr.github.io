import type { APIRoute } from 'astro';
import { searchIndexJson } from '../site/search-index';

/**
 * §8 — `/search-index.json`, the document the search box lazy-loads on first
 * focus.
 *
 * Thin on purpose, on the model of `chain.json.ts` and `rss.xml.ts`: everything
 * the document says — what is in it, what is deliberately not, and in what
 * order — is decided in `src/site/search-index.ts`, so there is one place to
 * read and one place to change.
 *
 * Nothing here or in the module behind it reads the clock, and every ordering
 * in the document is total and codepoint-based, so two builds of one unchanged
 * chain produce identical bytes.
 */
export const GET: APIRoute = async () =>
  new Response(await searchIndexJson(), {
    // A static host serves `dist/search-index.json` by extension; this is the
    // header `astro dev` answers with, where the extension buys nothing.
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
