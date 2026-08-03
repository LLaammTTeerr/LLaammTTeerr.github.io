import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRules, selectorParts } from './css';
import { DIST, distPages, internalHrefs, readDist, resolvesIn, rowFor } from './dist';
import { getAddresses } from '../../src/site/addresses';
import { getPosts, postMetaLine, researchHours, shortHash } from '../../src/site/chain-data';

/**
 * `/address` and `/address/[name]` as the build actually ships them.
 *
 * Read from `dist/`, not from the view functions: `addresses.test.ts` can only
 * prove `getAddresses()` is right as a function, and nothing there stops a
 * route from ceasing to call it. Every expectation is derived from the chain
 * and anchored to markup unique to what it checks — the address page's own
 * `data-address` card and its `.meta` field values — because the nav, the
 * `<title>` and the page heading all echo the same strings and a bare
 * `toContain` is satisfied by any of them.
 */

const view = async (name: string) => (await getAddresses()).find((a) => a.name === name)!;

/** The address route's own file. Its path is the thing under test (see below). */
const pageFor = (name: string): string => readDist(`address/${name}/index.html`);

/** The card the address page renders, without the nav and layout around it. */
function cardOf(html: string): string {
  const m = /<article class="card"[^>]*data-address="[^"]*"[\s\S]*?<\/article>/.exec(html);
  if (m === null) throw new Error('the page has no address card');
  return m[0];
}

describe('the dotted route param', () => {
  it('emits a directory page for a name with a dot in it', async () => {
    // The trap this project already fell into: `meta.tag` looks like a
    // filename. Astro must emit `dist/address/meta.tag/index.html` — a
    // directory with an index — and not `dist/address/meta.tag` as a file,
    // which would 404 behind a trailing slash and which `resolvesIn` (rightly)
    // treats differently.
    const names = (await getAddresses()).map((a) => a.name);
    expect(names.length, 'the chain produced no addresses to build').toBeGreaterThan(0);
    for (const name of names) {
      expect(name).toContain('.');
      expect(distPages(), `${name} has no built page`).toContain(`address/${name}/index.html`);
      expect(resolvesIn(DIST, `/address/${name}`), `/address/${name} does not resolve`).toBe(true);
    }
  });

  it('builds one page per address on the chain, and no more', async () => {
    const built = distPages().filter((p) => /^address\/[^/]+\/index\.html$/.test(p));
    expect(built.length).toBe((await getAddresses()).length);
  });

  it('builds an index at /address for the nav to point at', () => {
    // routes.ts has one `built` flag per route, and flipping it to link
    // `/address/<tag>.tag` from TxPanel also links `/address` from the nav.
    // `resolvesIn` deliberately rejects a bare directory, so the container
    // holding the address pages does not satisfy this.
    expect(distPages()).toContain('address/index.html');
    expect(resolvesIn(DIST, '/address')).toBe(true);
  });
});

describe('an address page', () => {
  it('renders the address the engine derives, in full', async () => {
    // Its own detail page, so the whole value — §3.1 truncates in lists only,
    // because this page exists to be verified from with JavaScript off.
    const meta = await view('meta.tag');
    expect(cardOf(pageFor('meta.tag'))).toContain(`<span class="addr">${meta.address}</span>`);
    expect(cardOf(pageFor('meta.tag')), 'the address is middle-truncated on its own page').not.toContain(
      shortHash(meta.address),
    );
  });

  it('states the value it received, not the value the chain holds', async () => {
    // §3.8. Anchored to the `<span class="num">` the Received row renders, so
    // digits echoed elsewhere on the page cannot satisfy it.
    const meta = await view('meta.tag');
    const hours = researchHours(meta.valueReceived)!;
    expect(hours, 'meta.tag received no declared hours to render').not.toBeNull();
    expect(cardOf(pageFor('meta.tag'))).toContain(
      `<dt>Received</dt><dd><span class="num">${hours}</span> giờ nghiên cứu</dd>`,
    );
  });

  it('states its transaction count, first seen and last seen', async () => {
    const meta = await view('meta.tag');
    const card = cardOf(pageFor('meta.tag'));
    expect(card).toContain(`<dt>Txns</dt><dd><span class="num">${meta.txCount}</span></dd>`);
    expect(card).toContain(`<dt>First seen</dt><dd>${meta.firstSeen}</dd>`);
    expect(card).toContain(`<dt>Last seen</dt><dd>${meta.lastSeen}</dd>`);
  });

  it('lists every transaction that sent to it, linked to its post', async () => {
    const meta = await view('meta.tag');
    const card = cardOf(pageFor('meta.tag'));
    expect(meta.transactions.length, 'meta.tag received nothing to list').toBeGreaterThan(0);
    for (const tx of meta.transactions) {
      expect(card, `${tx.slug} is not linked from its address page`).toContain(
        `<a href="/tx/${tx.slug}">${tx.title}</a>`,
      );
      // §3.1 — truncated here, because this is a list and the transaction has
      // a detail page of its own where the full hash lives.
      expect(card).toContain(shortHash(tx.hash));
      expect(card, `${tx.slug}'s full hash appears untruncated in a list`).not.toContain(tx.hash);
    }
  });

  it("states each row's word count and research hours, from the chain's current record", async () => {
    // The line that carried the Critical, and that nothing asserted: deleting
    // `{txMetaLine(tx)}` from this page and from `/about` left 704/704 green.
    // It is also where the card used to contradict its own header — the total
    // above resolved amendments (§3.9) and these rows did not.
    const meta = await view('meta.tag');
    const card = cardOf(pageFor('meta.tag'));
    expect(meta.transactions.length, 'meta.tag received nothing to list').toBeGreaterThan(0);
    for (const post of meta.transactions) {
      const row = rowFor(card, post.slug);
      expect(row, `${post.slug} has no row on its address page`).not.toBeNull();
      expect(row!, `${post.slug}'s row states no figures`).toContain(postMetaLine(post));
      // Anchored to the real numbers too, so a `postMetaLine` that returned a
      // constant would still have to return the right one.
      expect(row!).toContain(`${post.gasUsed} từ`);
      expect(row!).toContain(`${researchHours(post.value)} giờ`);
    }
  });

  it('adds up: the rows sum to the total the card header states', async () => {
    // §3.8. The card printed `Received 15.0` over rows summing to 6.5 after an
    // amendment. Stated as arithmetic over what the page actually rendered, so
    // it is the *card* that has to be consistent, not two functions.
    const meta = await view('meta.tag');
    const card = cardOf(pageFor('meta.tag'));
    const hours = [...card.matchAll(/· ([\d.]+) giờ<\/span>/g)].map((m) => Number(m[1]!));
    expect(hours.length, 'no row on the card states an hours figure').toBe(meta.transactions.length);
    const stated = /<dt>Received<\/dt><dd><span class="num">([\d.]+)<\/span>/.exec(card);
    expect(stated, 'the card states no Received total').not.toBeNull();
    expect(hours.reduce((a, b) => a + b, 0)).toBeCloseTo(Number(stated![1]!), 5);
  });

  it('lists no transaction that sent somewhere else', async () => {
    // Stated as a count, not as "these particular posts are absent": the
    // shipped ledger has no post outside `meta.tag`, so an absence check over
    // it would assert nothing at all. A page that listed every post on the
    // chain — the obvious wrong implementation — fails this the moment a
    // second post lands, and fails the fixture suite today.
    const meta = await view('meta.tag');
    const card = cardOf(pageFor('meta.tag'));
    const linked = [...card.matchAll(/href="\/tx\/([^"]+)"/g)].map((m) => m[1]!);
    expect(linked.length, 'the address card links no transaction at all').toBeGreaterThan(0);
    expect(new Set(linked)).toEqual(new Set(meta.transactions.map((t) => t.slug)));
    const strangers = getPosts().filter((t) => !t.tags.includes('meta'));
    for (const tx of strangers) {
      expect(linked, `${tx.slug} never sent to meta.tag but is listed on its page`).not.toContain(
        tx.slug,
      );
    }
  });
});

describe('the address index', () => {
  it('links every address, middle-truncated', async () => {
    const html = readDist('address/index.html');
    const addresses = await getAddresses();
    expect(addresses.length, 'no addresses to list').toBeGreaterThan(0);
    for (const address of addresses) {
      expect(html, `${address.name} is not linked from /address`).toContain(
        `<a href="/address/${address.name}">${address.name}</a>`,
      );
      expect(html).toContain(`<span class="addr">${shortHash(address.address)}</span>`);
      expect(html, `${address.name}'s full address appears untruncated in a list`).not.toContain(
        `>${address.address}<`,
      );
    }
  });
});

describe('the tag links that made this route necessary', () => {
  it('links every tag a post page names, and every one of those links resolves', async () => {
    // The reason this task existed: the post page named its tags as plain
    // text because the route did not exist. Read from the built post pages,
    // so this fails if TxPanel stops linking or if a link points at a page
    // getStaticPaths did not produce.
    const posts = getPosts();
    expect(posts.length, 'no post pages to check').toBeGreaterThan(0);
    let checked = 0;
    for (const tx of posts) {
      const html = readDist(`tx/${tx.slug}/index.html`);
      const targets = [...tx.tags.map((t) => `${t}.tag`)];
      if (tx.series !== null) targets.push(`${tx.series}.series`);
      expect(targets.length, `${tx.slug} declares no tags`).toBeGreaterThan(0);
      for (const name of targets) {
        expect(html, `${name} is not a link on ${tx.slug}'s page`).toContain(
          `<a class="tagname" href="/address/${name}">${name}</a>`,
        );
        expect(resolvesIn(DIST, `/address/${name}`), `/address/${name} 404s`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('leaves no link on an address page pointing at a page that was never built', () => {
    let checked = 0;
    for (const page of distPages().filter((p) => p.startsWith('address/'))) {
      for (const href of internalHrefs(readDist(page))) {
        expect(resolvesIn(DIST, href), `${href} is linked from ${page} but was never built`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('the address styles', () => {
  it('styles the address token through a token, never a literal colour', () => {
    // Eleven reader-selectable palettes redefine --c-addr; a literal here
    // would be wrong under ten of them. Scoped to the rule this task added,
    // the way nav.test.ts and pending-render.test.ts scope theirs — the
    // whole-file scan already lives in pending-render.test.ts.
    const css = readFileSync('src/styles/chain.css', 'utf8');
    const rule = parseRules(css).find((r) => selectorParts(r).includes('.addr'));
    expect(rule, '.addr is not a rule in chain.css — the guard is not scanning it').toBeDefined();
    expect(rule!.body).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(rule!.body, '.addr declares no colour at all').toContain('var(--c-addr)');
  });
});
