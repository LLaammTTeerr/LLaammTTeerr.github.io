import { basename } from 'node:path';
import matter from 'gray-matter';
import { slugify, tagAddress } from './address';
import {
  canonicalPostTx,
  normalizeBody,
  wordCount,
} from './canonical';
import { sha256Hex } from './hash';
import type { Hex, PostInput, Transaction } from './types';

function required(value: unknown, field: string, filePath: string): string {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${filePath}: missing required frontmatter field "${field}"`);
  }
  return String(value);
}

/** YAML may parse an unquoted date into a Date; normalize both forms. */
function toDateString(value: unknown, filePath: string): string {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${filePath}: "date" must be YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

/**
 * `slugify` can collapse input that is entirely punctuation (e.g. a tag of
 * "!!!") into an empty string, which would otherwise silently produce a
 * malformed address downstream. Fail loudly instead, naming the file and
 * field so the author can fix the source post.
 */
function requireSlug(original: string, slug: string, field: string, filePath: string): string {
  if (slug === '') {
    throw new Error(
      `${filePath}: "${field}" value "${original}" slugifies to an empty string — use at least one letter or digit`,
    );
  }
  return slug;
}

export function parsePost(filePath: string, raw: string): PostInput {
  const { data, content } = matter(raw);

  const title = required(data.title, 'title', filePath);
  if (data.date === undefined) {
    throw new Error(`${filePath}: missing required frontmatter field "date"`);
  }
  const date = toDateString(data.date, filePath);

  const tags = Array.isArray(data.tags)
    ? data.tags.map((t) => requireSlug(String(t), slugify(String(t)), 'tags', filePath))
    : [];
  const series = data.series
    ? requireSlug(String(data.series), slugify(String(data.series)), 'series', filePath)
    : null;
  const research = data.research === undefined ? 0 : Number(data.research);
  if (!Number.isFinite(research) || research < 0) {
    throw new Error(`${filePath}: "research" must be a non-negative number`);
  }
  // §3.2 — research is fixed at exactly one decimal place when hashed
  // (canonicalPostTx uses formatResearch, i.e. toFixed(1)). A value with
  // more precision would silently round on the way into the hash while
  // `tx.value` kept the unrounded number, so the displayed and hashed
  // values would disagree. Reject at the door instead of rounding silently.
  if (Math.round(research * 10) !== research * 10) {
    throw new Error(
      `${filePath}: "research" must have at most one decimal place, got ${research}`,
    );
  }

  return {
    slug: basename(filePath).replace(/\.md$/, ''),
    title,
    date,
    tags,
    series,
    research,
    summary: data.summary ? String(data.summary) : '',
    body: content,
  };
}

export async function toTransaction(post: PostInput, from: Hex): Promise<Transaction> {
  const normalized = normalizeBody(post.body);
  const contentHash = await sha256Hex(normalized);

  const hash = await sha256Hex(
    canonicalPostTx({
      title: post.title,
      date: post.date,
      tags: post.tags,
      series: post.series,
      research: post.research,
      from,
      contentHash,
      assets: [],
    }),
  );

  const recipients = [...post.tags, ...(post.series ? [post.series] : [])];
  const to = await Promise.all(recipients.map(tagAddress));

  return {
    hash,
    type: 'post',
    slug: post.slug,
    title: post.title,
    date: post.date,
    tags: post.tags,
    series: post.series,
    from,
    to,
    contentHash,
    assets: [],
    gasUsed: wordCount(normalized),
    value: post.research,
    // §3.9 — `research` is amendment-only metadata; on a post the declared
    // hours are `value` itself.
    research: null,
    amends: null,
  };
}
