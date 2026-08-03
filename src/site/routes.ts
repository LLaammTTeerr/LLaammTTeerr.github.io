/**
 * The site's whole shape — every top-level section it means to have,
 * whether or not this build has produced a page for it yet.
 *
 * `Base.astro`'s nav and `TxPanel.astro`'s tag/series links both name these
 * same routes, and both used to carry their own idea of which ones exist —
 * the nav linked all six, `TxPanel` linked `/address` unconditionally, and
 * both were wrong the moment a route was not actually built. This is the one
 * list both read, so a route landing later is a single `built: true` flip
 * here that fixes every place that names it, not a per-template
 * find-and-replace.
 *
 * A static list — no clock read here or anywhere under `src/site/`.
 */

export interface RouteEntry {
  id: string;
  href: string;
  label: string;
  built: boolean;
}

export const ROUTES: RouteEntry[] = [
  { id: 'about', href: '/about', label: 'About', built: true },
  { id: 'blocks', href: '/blocks', label: 'Blocks', built: true },
  { id: 'tx', href: '/tx', label: 'Transactions', built: false },
  { id: 'address', href: '/address', label: 'Addresses', built: true },
  { id: 'assets', href: '/assets', label: 'Assets', built: false },
  { id: 'mempool', href: '/mempool', label: 'Mempool', built: true },
  { id: 'verify', href: '/verify', label: 'Verify', built: false },
];

/** A single route by id. Throws on a typo'd id rather than rendering nothing. */
export function routeById(id: string): RouteEntry {
  const route = ROUTES.find((r) => r.id === id);
  if (route === undefined) throw new Error(`no route named "${id}" in ROUTES`);
  return route;
}
