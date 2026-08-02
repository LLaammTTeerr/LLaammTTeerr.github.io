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
  date: string;
  amends: Hex;
  from: Hex;
  contentHash: Hex;
}

export function canonicalAmendmentTx(a: CanonicalAmendmentFields): string {
  return [
    'tx/1',
    'type:amendment',
    `date:${a.date}`,
    `amends:${a.amends}`,
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
