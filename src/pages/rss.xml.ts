import type { APIRoute } from 'astro';
import { feedXml } from '../site/feed';

/**
 * §6 — `/rss.xml`, the feed a reader subscribes to.
 *
 * Thin on purpose, on the model of `chain.json.ts`: everything the document
 * says is decided in `src/site/feed.ts`, which is where the rule that makes
 * this route different from `/blocks` is written down. The one thing this file
 * owns is `site`, because that is Astro's, not the ledger's.
 *
 * **`site` is required.** RSS urls must be absolute — a relative one resolves
 * against the reader's aggregator, not against this site, so it points at
 * nothing — and Astro leaves `context.site` undefined when `astro.config.mjs`
 * declares none. There is no honest fallback: guessing a host would publish a
 * feed of links to somebody else's domain. Failing the build is the only
 * outcome that tells the author what is missing, and it is the same posture as
 * every other check here (a figure that cannot be derived is never printed).
 *
 * Nothing in this route or the module behind it reads the clock, so two builds
 * of one unchanged chain produce identical bytes.
 */
export const GET: APIRoute = async ({ site }) => {
  if (site === undefined) {
    throw new Error(
      'astro.config.mjs declares no `site`, and every url in an RSS feed must be absolute — ' +
        'set it to the domain the site is published at',
    );
  }
  return new Response(await feedXml(site), {
    // A static host serves `dist/rss.xml` by extension; this is the header
    // `astro dev` answers with, where the extension buys nothing.
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
};
