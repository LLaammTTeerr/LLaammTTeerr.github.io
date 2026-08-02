import type { BlockHeader, Hex } from './types';

/** §3.1 — normalize before hashing. Applied to raw Markdown, never to rendered HTML. */
export function normalizeBody(body: string): string {
  const lf = body.replace(/\r\n?/g, '\n');
  const trimmed = lf
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
  return trimmed.replace(/\n*$/, '') + '\n';
}

/** §3.8 — gas is the word count of the normalized body. */
export function wordCount(normalizedBody: string): number {
  return normalizedBody.match(/\S+/g)?.length ?? 0;
}

/** §3.2 — fixed at one decimal place so 12.5, 12.50 and 12.500 cannot diverge. */
export function formatResearch(hours: number): string {
  return hours.toFixed(1);
}

export interface CanonicalPostFields {
  title: string;
  date: string;
  tags: string[];
  series: string | null;
  research: number;
  from: Hex;
  contentHash: Hex;
}

export function canonicalPostTx(p: CanonicalPostFields): string {
  const tags = p.tags.map((t) => t.toLowerCase()).sort();
  return [
    'tx/1',
    `title:${p.title}`,
    `date:${p.date}`,
    `tags:${tags.join(',')}`,
    `series:${p.series ?? ''}`,
    `research:${formatResearch(p.research)}`,
    `from:${p.from}`,
    `body:${p.contentHash}`,
  ].join('\n');
}

export interface CanonicalAmendmentFields {
  amends: Hex;
  date: string;
  title: string;
  tags: string[];
  series: string | null;
  research: number;
  from: Hex;
  contentHash: Hex;
}

/**
 * §3.9 — the amendment form, version `tx/2`.
 *
 * An edit to a sealed post may change nothing but its metadata: a retitle, a
 * new tag, a corrected research figure. `tx/1` covers those fields, so an
 * amendment must too — otherwise a metadata-only edit produces no hash change,
 * no amendment, and the ledger keeps the stale values forever.
 *
 * `tx/1` (posts) is unchanged. The on-disk chain carries no amendments, so
 * nothing needs migrating.
 */
export function canonicalAmendmentTx(a: CanonicalAmendmentFields): string {
  const tags = a.tags.map((t) => t.toLowerCase()).sort();
  return [
    'tx/2',
    'type:amendment',
    `amends:${a.amends}`,
    `date:${a.date}`,
    `title:${a.title}`,
    `tags:${tags.join(',')}`,
    `series:${a.series ?? ''}`,
    `research:${formatResearch(a.research)}`,
    `from:${a.from}`,
    `body:${a.contentHash}`,
  ].join('\n');
}

export function canonicalBlockHeader(h: BlockHeader): string {
  return [
    'block/1',
    `height:${h.height}`,
    `prevHash:${h.prevHash}`,
    `merkleRoot:${h.merkleRoot}`,
    `timestamp:${h.timestamp}`,
    `txCount:${h.txCount}`,
    `gasUsed:${h.gasUsed}`,
    `difficulty:${h.difficulty}`,
    `nonce:${h.nonce}`,
  ].join('\n');
}
