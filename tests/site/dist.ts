import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIST = 'dist';

/**
 * Read a file from the build output, with an error that says what to do.
 * Call this INSIDE a test, never at module top level — a top-level throw
 * fails the entire file at import time and hides which assertion broke.
 *
 * `dist/` is built by vitest's globalSetup (tests/global-setup.ts) before
 * any test runs, so it is always current with the sources under test.
 */
export function readDist(relPath: string): string {
  const path = join(DIST, relPath);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the build in tests/global-setup.ts should have produced it`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * Every stylesheet the built homepage actually loads, concatenated: the
 * hashed `_astro/*.css` bundles it links plus any `<style>` Astro chose to
 * inline. Assertions about what reaches the browser must read this, not the
 * source CSS — a source file no component imports never reaches `dist`.
 */
export function readDistCss(): string {
  const html = readDist('index.html');
  const linked = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) =>
    readDist(m[1]!.replace(/^\//, '')),
  );
  const inlined = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
  const all = [...linked, ...inlined];
  if (all.length === 0) throw new Error('dist/index.html loads no CSS at all');
  return all.join('\n');
}
