import { sha256, toHex } from './hash';
import type { Hex } from './types';

/**
 * NFD decomposition separates most Vietnamese diacritics into combining marks
 * which we then strip. `đ`/`Đ` have no decomposition, so they are mapped
 * explicitly — and must be mapped AFTER the combining-mark strip, since that
 * strip does not touch them.
 */
export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** §3.7 — first 20 bytes of a domain-separated digest. */
async function address(domain: string, value: string): Promise<Hex> {
  const digest = await sha256(`addr/1|${domain}|${value}`);
  return '0x' + toHex(digest).slice(0, 40);
}

export function tagAddress(slug: string): Promise<Hex> {
  return address('tag', slug);
}

export function identityAddress(handle: string): Promise<Hex> {
  return address('identity', handle);
}

export function tagName(slug: string): string {
  return `${slug}.tag`;
}
