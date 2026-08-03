import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePost } from '../chain/post';
import { byCodepoint } from '../chain/seal';
import { getPendingBlock, getPosts } from './chain-data';

/**
 * §3.6 — the mempool: writing that has **not been published**, and is
 * therefore not in the chain at all.
 *
 * The spec draws this line and forbids blurring it: the mempool holds drafts;
 * the *open block* holds published posts awaiting the next seal. Those are
 * different things, and everything the rest of the site renders — hashes,
 * addresses, gas, value, block membership — belongs to the second and to none
 * of the first.
 *
 * So this module deliberately stops where `src/chain/post.ts` stops being
 * about the file and starts being about the chain. It calls `parsePost`, so a
 * draft and a post agree on frontmatter and the author writes one format; it
 * never calls `toTransaction`, never derives an address, never counts gas and
 * never hashes anything. A hash computed here would be a genuine SHA-256 of
 * genuine text and still a lie, because printing one beside a title on this
 * site means "this is on the chain" — and it is not. There is no field on
 * `Draft` that could carry one, which is the point: a template can only print
 * what the view hands it.
 *
 * Reads no clock (§14), like everything else under `src/site/`: a draft's date
 * is the one it declares, so the same directory builds the same page any day.
 */

/** A draft: a title and a date. No hash, no address, no gas, no value. */
export interface Draft {
  /** The filename, as a post's slug would be — never a route; drafts have no page. */
  slug: string;
  title: string;
  /** YYYY-MM-DD, the author's declared date. Not a block, not a placement. */
  date: string;
}

const DRAFTS_DIR = 'content/drafts';
const POSTS_DIR = 'content/posts';

/**
 * Every draft in `draftsDir`, newest first.
 *
 * An empty or absent directory is the ordinary case, not an error: the site
 * ships with `content/drafts/` holding nothing but a `.gitkeep`, and most of
 * its life it holds nothing else. The page renders an explicit empty state
 * from the empty array.
 *
 * Refuses — loudly, failing the build — a draft whose slug is already
 * published, either as a file in `postsDir` or as a transaction on the chain.
 * One piece of writing cannot be both in the mempool and in the chain, and the
 * two ways an author reaches that state (copying a draft into `content/posts/`
 * instead of moving it, or deleting the post file and leaving the draft) both
 * end with the same words rendered twice under contradictory claims. That is
 * an authoring mistake with a one-line fix, and it is worth saying so instead
 * of quietly picking one of the two answers.
 *
 * The directories are parameters only so tests can point at fixtures;
 * production callers use the defaults.
 */
export function getDrafts(draftsDir: string = DRAFTS_DIR, postsDir: string = POSTS_DIR): Draft[] {
  if (!existsSync(draftsDir)) return [];

  const drafts = readdirSync(draftsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const path = join(draftsDir, name);
      // The same parser posts use — and only for its frontmatter. `PostInput`
      // carries tags, series, research and a body too; none of them reach a
      // `Draft`, because each is a claim the chain has not recorded.
      const parsed = parsePost(path, readFileSync(path, 'utf8'));
      return { slug: parsed.slug, title: parsed.title, date: parsed.date };
    });

  for (const draft of drafts) {
    const where = publishedAs(draft.slug, postsDir);
    if (where !== null) {
      throw new Error(
        `"${draft.slug}" is a draft in ${join(draftsDir, `${draft.slug}.md`)} and is already ` +
          `published (${where}) — a post cannot be in the mempool and in the chain at once; ` +
          `delete the draft, or unpublish the post`,
      );
    }
  }

  // Newest first, the same order the chain reads in (§9). Ties broken on slug
  // so two drafts written on one day do not swap places between builds with
  // the directory order — by codepoint, because `localeCompare` reads the
  // machine's `LC_ALL` and two drafts whose slugs start `ch-` and `h-` swap
  // under a Czech collation (see `byCodepoint` in `src/chain/seal.ts`).
  return drafts.sort((a, b) => byCodepoint(b.date, a.date) || byCodepoint(a.slug, b.slug));
}

/**
 * Where `slug` is published, or `null` if it is not.
 *
 * Both halves are needed and neither implies the other. The file check catches
 * the common case before `chain:build` has run, when the post exists on disk
 * and no transaction names it yet. The chain check catches the reverse — a
 * transaction whose file has been moved back into `content/drafts/` — which the
 * file check cannot see, and which would otherwise put a draft in the mempool
 * while a sealed transaction on the chain still claimed it.
 */
function publishedAs(slug: string, postsDir: string): string | null {
  const path = join(postsDir, `${slug}.md`);
  if (existsSync(path)) return path;
  const pending = getPendingBlock();
  const onChain = [...getPosts(), ...(pending === null ? [] : pending.transactions)];
  return onChain.some((tx) => tx.slug === slug) ? 'a transaction on the chain' : null;
}
