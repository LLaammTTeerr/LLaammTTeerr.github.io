import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DIST = 'dist';

/**
 * Read a file from the build output, with an error that says what to do.
 * Call this INSIDE a test, never at module top level — a top-level throw
 * fails the entire file at import time and hides which assertion broke.
 */
export function readDist(relPath: string): string {
  const path = join(DIST, relPath);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`npm run build\` before \`npm test\`, or use \`npm run test:all\``);
  }
  return readFileSync(path, 'utf8');
}
