import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vietnamese needs precomposed glyphs from Latin Extended Additional. A font
 * missing them does not fail loudly — the browser substitutes another face
 * mid-word, which looks like sloppy typography rather than a missing font.
 *
 * Fontsource ships per-subset files named `*-vietnamese-*.woff2`. Their
 * presence is the signal we check: the packager only emits a Vietnamese
 * subset when the source font actually covers the range.
 */

const SAMPLE = 'Khối đầu tiên · Ghi chú thuật toán · Đường đi · Tư tưởng · Cộng hòa';

export function hasVietnameseSubset(pkgDir: string): boolean {
  const files = readdirSync(join(pkgDir, 'files'));
  return files.some((f) => f.includes('vietnamese') && f.endsWith('.woff2'));
}

export function vietnameseFilesFor(pkgDir: string): string[] {
  return readdirSync(join(pkgDir, 'files'))
    .filter((f) => f.includes('vietnamese') && f.endsWith('.woff2'))
    .sort();
}

const PACKAGES = [
  'node_modules/@fontsource/be-vietnam-pro',
  'node_modules/@fontsource/jetbrains-mono',
];

if (import.meta.url === `file://${process.argv[1]}`) {
  let ok = true;
  console.log(`sample: ${SAMPLE}\n`);
  for (const pkg of PACKAGES) {
    const name = pkg.split('/').pop();
    const files = vietnameseFilesFor(pkg);
    if (files.length === 0) {
      console.error(`  ✗ ${name} — no vietnamese subset; do not use for Vietnamese text`);
      ok = false;
    } else {
      console.log(`  ✓ ${name} — ${files.length} vietnamese file(s), e.g. ${files[0]}`);
    }
  }
  if (!ok) process.exit(1);
}
