import type { APIRoute } from 'astro';
import { getPendingPosts, getPostContent, getPosts } from '../../../site/chain-data';

/**
 * §7 — one post's **canonical source**: the normalized Markdown body, exactly
 * the bytes the chain hashed into `contentHash`.
 *
 * The site serves each post as rendered HTML, and hashing that proves nothing.
 * `contentHash` is over the normalized body (§3.1), and neither normalization
 * nor Markdown rendering is reversible, so a reader handed the page could never
 * reach the committed value however carefully they hashed it. Without this
 * route "Verify this transaction" would have nothing to verify *from*, and the
 * loop §7 asks for — raw text through to block hash — would be open at the end
 * that matters most.
 *
 * **A sibling file rather than the body embedded in the page**, and the reason
 * is the one property this project trades everything for:
 *
 *     curl -s <site>/tx/<slug>/body.txt | sha256sum
 *
 * Two standard commands, and the reader has the committed hash without running
 * a line of our JavaScript. Embedded in the page the body would have to be
 * extracted from surrounding markup and un-escaped before it could be hashed —
 * a transformation the reader would have to take our word for, which is exactly
 * the trust the verifier exists to remove. It would also ship every body twice,
 * once as source and once as rendered HTML, on a page a reader may well be on
 * to read rather than to audit.
 *
 * `text/plain` and nothing else. A body is Markdown, but `text/markdown` would
 * invite a browser to download it rather than show it, and what a reader wants
 * from this url is to *look* at it beside the post.
 *
 * A page is built for every post the chain records, sealed or not (§3.6), so
 * the source is published for every one of them too — a pending post is the one
 * whose body is most likely to have drifted, and it is checkable to exactly the
 * depth an unmined transaction can be checked.
 *
 * `getPostContent` is what makes this safe to publish: it re-derives the hash
 * from disk and throws when the file no longer matches the chain, so a drifted
 * body fails the build rather than being served under a hash that does not
 * cover it. Reads no clock (§14).
 */
export function getStaticPaths() {
  return [...getPosts(), ...getPendingPosts()].map((tx) => ({
    params: { slug: tx.slug! },
    props: { slug: tx.slug! },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const content = await getPostContent(props.slug as string);
  // `content.body` is the normalized body — `getPostContent` has already proved
  // it hashes to what the governing transaction committed. `Response` encodes a
  // string as UTF-8, which is the encoding `sha256Hex` hashes in, so the bytes
  // on the wire are the bytes that were hashed.
  return new Response(content.body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
