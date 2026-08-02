import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, readDist } from './dist';

describe('static build output', () => {
  it('emits an index page', () => {
    expect(existsSync(join(DIST, 'index.html'))).toBe(true);
  });

  it('is a real HTML document', () => {
    const html = readDist('index.html');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('ships no server entrypoint', () => {
    expect(existsSync(join(DIST, 'server'))).toBe(false);
    expect(existsSync(join(DIST, 'entry.mjs'))).toBe(false);
  });
});
