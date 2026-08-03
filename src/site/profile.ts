import { readFileSync } from 'node:fs';
import matter from 'gray-matter';

/**
 * §6 — the author's bio and links, read from `content/profile.md`.
 *
 * This is author-controlled prose, not chain data: nothing in this file is
 * covered by a transaction hash, so nothing read from it may stand in for a
 * committed field. `src/pages/about.astro` still derives the identity
 * address from `identityAddress(CHAIN_CONFIG.authorHandle)` (§3.7) and prints
 * `CHAIN_CONFIG.authorName` for the page heading — never a `name`/`handle`
 * this file might carry — so a stray edit to `content/profile.md` can change
 * the bio and the links and nothing else.
 *
 * The one module that reads `content/profile.md`, on the model of
 * `chain-data.ts` being the one module that reads the ledger: a template
 * that wants the profile imports from here, never `gray-matter` or the file
 * path directly.
 */

export interface ProfileLink {
  label: string;
  url: string;
}

export interface Profile {
  /** Raw markdown — render through `renderMarkdown` before printing (§6.1's guard applies to author prose too). */
  bio: string;
  links: ProfileLink[];
}

const PROFILE_PATH = 'content/profile.md';

/**
 * A frontmatter list entry as a `ProfileLink`, or `null` when it names no
 * label. A label-less entry is not a link a reader could recognise, so it is
 * dropped rather than rendered blank.
 *
 * `url` defaults to `''`, not to the label or to nothing at all — an empty
 * string is what `about.astro` filters on to decide whether an entry is
 * clickable (§6: "renders a link only for a profile entry that declares a
 * url"), so an entry the author has not finished filling in stays named in
 * the source and silent on the page rather than becoming a link to nowhere.
 */
function asLink(value: unknown): ProfileLink | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === 'string' ? record.label.trim() : '';
  if (label === '') return null;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  return { label, url };
}

/**
 * `content/profile.md`'s `bio` and `links`, or the empty profile — `bio: ''`,
 * `links: []` — for any frontmatter shape that does not name them. The empty
 * profile is not an error case: it is what `content/profile.md` ships as
 * until the author writes it, and `about.astro` must render it correctly
 * (no bio paragraph, no link section), not throw.
 *
 * `path` is a parameter only so tests can point at a fixture; production
 * callers use the default, on the model of `getPostContent`'s `postsDir`.
 */
export function getProfile(path: string = PROFILE_PATH): Profile {
  const { data } = matter(readFileSync(path, 'utf8'));
  const bio = typeof data.bio === 'string' ? data.bio : '';
  const links = Array.isArray(data.links)
    ? data.links.map(asLink).filter((l): l is ProfileLink => l !== null)
    : [];
  return { bio, links };
}
