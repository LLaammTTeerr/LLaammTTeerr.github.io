import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

/**
 * §6 — the author's projects, presented as deployed contracts.
 *
 * §5.1 puts `content/contracts/` outside the chain, in as many words: only
 * `content/posts/` becomes transactions, and the contracts directory is "read
 * at build time and rendered; nothing hashes them" — the same standing as
 * `content/drafts/` and `content/profile.md`.
 *
 * So this module is `src/site/drafts.ts`'s sibling, and stops where it stops.
 * It builds no `Transaction`, derives no address, counts no gas and hashes
 * nothing. A SHA-256 computed here would be a genuine hash of genuine text and
 * still a lie, because a hash printed beside a name on this site means "this is
 * on the chain" — and a project is not. There is no field on `Contract` that
 * could carry one, which is the point: a template can only print what the view
 * hands it.
 *
 * **On the word "verified."** §6 describes this route as "projects as verified
 * contracts, source linked to GitHub", and on a real explorer "verified" has a
 * precise meaning: the published source recompiles to the deployed bytecode,
 * and anyone can rerun that check. Everywhere else on this site the word means
 * the same kind of thing — recomputable from a committed hash. A `repo` url is
 * not that. It names a repository that can change, move or vanish tomorrow, and
 * nothing in this build fetches it, pins it or checks it. So `Contract` carries
 * no `verified` field and the pages render no such badge; the source is offered
 * as a link and labelled as one. What it would take to earn the word is written
 * up in this task's report, and it is not a wording change.
 *
 * Reads no clock (§14), like everything else under `src/site/`: a directory of
 * files builds the same pages on any day.
 */

/** A project. No hash, no address, no gas, no block, no verification. */
export interface Contract {
  /** The filename, and the route param on `/contract/[name]`. */
  slug: string;
  /** Display name, falling back to the slug so a page is never nameless. */
  name: string;
  /** One line for the list. `''` when the author has written none. */
  summary: string;
  /**
   * An `https` url, or `null`. Never a half-filled frontmatter value: the
   * template renders an anchor if and only if this is non-null, so anything
   * that is not a url has to arrive here as `null` rather than as a string a
   * reader could click into nowhere (§6, and `/about`'s rule for a profile
   * link before it).
   */
  repo: string | null;
  language: string | null;
  /** Markdown — render through `renderMarkdown` before printing. */
  body: string;
}

const CONTRACTS_DIR = 'content/contracts';

/** A frontmatter string, trimmed, or `''` for anything that is not one. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `raw` as a repository url, or `null`.
 *
 * `https` only, and deliberately stricter than `markdown.ts`'s `SAFE_SCHEMES`
 * (which also allows `http` and `mailto`): this value is not author prose that
 * happens to contain a link, it is a field the page presents as *the source of
 * this project*, and a plaintext `http` url for a code host in 2026 is a typo
 * rather than an intention. Everything else — an empty value, a `TODO`, a bare
 * `github.example/x`, a `javascript:` scheme — is not a url and becomes `null`,
 * which is what makes the template render no anchor at all instead of a dead
 * one. There is no third state: `Contract.repo` is a url or it is nothing.
 */
function repoUrl(raw: unknown): string | null {
  const url = text(raw);
  if (url === '') return null;
  // No whitespace inside, so a frontmatter line that ran on into a comment or a
  // second value cannot be handed to the browser as one url.
  return /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}

/**
 * Every contract in `dir`, ordered by slug.
 *
 * An empty or absent directory is the ordinary case, not an error: the site
 * ships with `content/contracts/` holding nothing but a `.gitkeep`, and it may
 * hold nothing else for a long while. `/contracts` renders an explicit empty
 * state from the empty array.
 *
 * Ordered by slug rather than by display name: the slug is the filename, is
 * ASCII, and does not depend on the collation the machine running the build
 * happens to have — the same directory therefore produces the same page order
 * everywhere. Nothing here reads a date, so there is no "newest first" to have.
 *
 * `dir` is a parameter only so tests can point at fixtures; production callers
 * use the default, on the model of `getDrafts` and `getProfile`.
 */
export function getContracts(dir: string = CONTRACTS_DIR): Contract[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const slug = name.slice(0, -3);
      const { data, content } = matter(readFileSync(join(dir, name), 'utf8'));
      const language = text(data.language);
      return {
        slug,
        // Never empty: a contract with no declared name is still a page, and a
        // blank heading reads as a broken build rather than as missing
        // frontmatter.
        name: text(data.name) || slug,
        summary: text(data.summary),
        repo: repoUrl(data.repo),
        language: language === '' ? null : language,
        body: content.trim(),
      };
    });
}
