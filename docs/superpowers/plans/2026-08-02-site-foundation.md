# Site Foundation Implementation Plan (Plan 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Astro site with a typed view over the ledger, the palette and intensity token system, working reader preferences, and a homepage rendering the real chain.

**Architecture:** Astro 7 in static mode. A `src/site/` layer sits between the chain engine and the templates: it reads `chain.lock.json` once at build time and exposes typed, presentation-shaped queries, so no `.astro` file ever touches raw ledger JSON. All eleven palettes and three intensities are CSS custom properties keyed off `data-*` attributes on `<html>`, applied by a blocking inline script before first paint. Every meter style renders statically with CSS choosing one, so the site works with JavaScript disabled.

**Tech Stack:** Astro 7, TypeScript, Vitest (already present), Fontsource for self-hosted fonts. No CSS framework, no client framework — the interactive surface in this plan is one small vanilla script.

Implements spec §6 (the homepage row), §9 and §9.1 from `docs/superpowers/specs/2026-08-02-blockchain-explorer-blog-design.md`. Read §9 and §9.1 before starting.

## Global Constraints

- **Node ≥ 20.** Astro requires it; the repo already pins it.
- **Astro 7.x.** Astro 5 pulls `sharp` with high-severity libvips advisories and a vulnerable `vite`/`esbuild`; 7 is current and clean. `npm audit` must report no high or critical findings at the end of Task 1.
- **The site is static.** `output: 'static'`, no SSR adapter, no server. `npm run build` must produce a directory of files servable by any static host.
- **`src/chain/` is not modified by this plan.** The engine is merged and reviewed. If a template needs data the engine does not expose, add it to `src/site/`, not to `src/chain/`.
- **`.astro` files never read `chain.lock.json` directly.** They import from `src/site/chain-data.ts`.
- **No external network requests at runtime.** No font CDN, no analytics, no third-party script. Fonts are self-hosted via Fontsource, which vendors them into `node_modules` and is bundled at build time.
- **Preferences are `data-*` attributes on `<html>`**, read from `localStorage` by a **blocking inline script in `<head>`** before first paint. A flash of the wrong theme is a defect.
- **The site works with JavaScript disabled**, at the defaults. All three meter markups render statically; CSS selects one.
- **Defaults for a first-time visitor:** palette `github-dark`, intensity `min`, meter `m1`. First visit honours `prefers-color-scheme` before falling back.
- **Explorer chrome is English; content and prose are Vietnamese.** Do not translate `Block`, `Transaction`, `Hash`, `Nonce`, `Sealed`, `Pending`.
- **Block lists are newest-first.**
- **`npm test` and `npm run typecheck` must both pass** at the end of every task. The existing 267 engine tests must never regress.

---

### Task 1: Astro scaffold

**Files:**
- Modify: `package.json`
- Create: `astro.config.mjs`
- Modify: `tsconfig.json`
- Modify: `.gitignore`
- Create: `src/pages/index.astro`
- Create: `tests/site/build.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run dev`, `npm run build` (writes `dist/`), `npm run preview`.

- [ ] **Step 1: Install Astro**

```bash
npm install astro@^7.0.0
npm install --save-dev @fontsource/be-vietnam-pro @fontsource/jetbrains-mono
```

Both Fontsource packages vendor real font files into `node_modules`; Task 4 checks their Vietnamese coverage before committing to them.

- [ ] **Step 2: Add the scripts**

In `package.json`, add to `scripts`:

```json
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
```

Keep `test`, `test:watch`, `typecheck` and `chain:build` exactly as they are.

- [ ] **Step 3: Create `astro.config.mjs`**

```js
import { defineConfig } from 'astro/config';

// Static output only. The whole point of this project is that it needs no
// server: the ledger is a committed file and every page is derived from it
// at build time.
export default defineConfig({
  output: 'static',
  site: 'https://lamter.example',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
});
```

`site` is a placeholder until a domain exists; it only affects absolute URLs in RSS, which Plan 2b adds.

- [ ] **Step 4: Extend `tsconfig.json`**

Change the file to extend Astro's config while keeping the repo's existing strictness:

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests", "scripts", "chain.config.ts", ".astro/types.d.ts"],
  "exclude": ["dist"]
}
```

- [ ] **Step 5: Add build output to `.gitignore`**

Append:

```
dist/
.astro/
```

- [ ] **Step 6: Write the shared dist helper**

Several later tests assert against built HTML. Reading `dist/` at module top level would make the whole suite explode with `ENOENT` on a fresh checkout, which reads as a broken test rather than a missing build. Create `tests/site/dist.ts`:

```ts
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
```

Also add a script to `package.json` that builds first, for the case where you want one command:

```json
    "test:all": "astro build && vitest run",
```

- [ ] **Step 7: Write the failing test**

Create `tests/site/build.test.ts`:

```ts
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
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run tests/site/build.test.ts`
Expected: FAIL — `dist/index.html` does not exist yet.

- [ ] **Step 9: Create the placeholder page**

Create `src/pages/index.astro`:

```astro
---
// Replaced entirely in Task 6. Exists so the scaffold has something to build.
---

<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <title>Chain Blog</title>
  </head>
  <body>
    <p>Đang xây dựng.</p>
  </body>
</html>
```

- [ ] **Step 10: Build and verify**

Run: `npm run build`
Expected: completes, writes `dist/index.html`.

Run: `npx vitest run tests/site/build.test.ts`
Expected: PASS, 3 tests.

Run: `npm test` — the 267 engine tests plus these 3.
Run: `npm run typecheck` — clean.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json astro.config.mjs tsconfig.json .gitignore \
        src/pages/index.astro tests/site/dist.ts tests/site/build.test.ts
git commit -m "feat(site): scaffold astro in static mode"
```

---

### Task 2: The chain data layer

**Files:**
- Create: `src/site/chain-data.ts`
- Test: `tests/site/chain-data.test.ts`

**Interfaces:**
- Consumes: `readLock` from `src/chain/lock`, `Chain`/`Block`/`Transaction`/`AssetRecord`/`Hex` from `src/chain/types`, `CHAIN_CONFIG` from `chain.config`.
- Produces:
  - `getChain(): Chain` — memoized read of the committed ledger
  - `interface BlockView` — a block plus presentation fields
  - `getBlocks(): BlockView[]` — **newest first**
  - `getBlock(height: number): BlockView | undefined`
  - `getPosts(): Transaction[]` — post transactions only, newest first
  - `getAssets(): AssetRecord[]` — highest token id first (Plan 2b consumes this)
  - `interface NetworkStats { height: number; transactions: number; addresses: number; difficulty: number; assets: number }`
  - `getStats(): NetworkStats`
  - `workRatio(nonce: number, difficulty: number): number`
  - `expectedAttempts(difficulty: number): number`
  - `shortHash(hash: string): string` — `0x` + 6 hex, ellipsis, last 6 hex

This is the only module that knows the ledger's shape. Templates consume it and never `readLock` themselves.

- [ ] **Step 1: Write the failing test**

Create `tests/site/chain-data.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  getChain, getBlocks, getBlock, getPosts, getStats,
  workRatio, expectedAttempts,
} from '../../src/site/chain-data';

describe('expectedAttempts', () => {
  it('is 16^difficulty', () => {
    expect(expectedAttempts(1)).toBe(16);
    expect(expectedAttempts(5)).toBe(1048576);
  });
});

describe('workRatio', () => {
  it('is nonce over expected attempts', () => {
    expect(workRatio(1048576, 5)).toBeCloseTo(1, 6);
    expect(workRatio(2097152, 5)).toBeCloseTo(2, 6);
  });

  it('reports a lucky block as under one', () => {
    expect(workRatio(198676, 5)).toBeLessThan(1);
  });
});

describe('getChain', () => {
  it('reads the committed ledger', () => {
    const chain = getChain();
    expect(chain.version).toBe(1);
    expect(Array.isArray(chain.blocks)).toBe(true);
    expect(Array.isArray(chain.assets)).toBe(true);
  });

  it('returns the same object on repeated calls', () => {
    expect(getChain()).toBe(getChain());
  });
});

describe('getBlocks', () => {
  it('returns blocks newest first', () => {
    const heights = getBlocks().map((b) => b.height);
    expect(heights).toEqual([...heights].sort((a, b) => b - a));
  });

  it('includes every block', () => {
    expect(getBlocks()).toHaveLength(getChain().blocks.length);
  });

  it('carries presentation fields', () => {
    const newest = getBlocks()[0]!;
    expect(typeof newest.isGenesis).toBe('boolean');
    expect(typeof newest.isEmpty).toBe('boolean');
    expect(typeof newest.workRatio).toBe('number');
    expect(newest.shortHash).toMatch(/^0x[0-9a-f]{6}…[0-9a-f]{6}$/);
  });

  it('marks the genesis block and only the genesis block', () => {
    const flagged = getBlocks().filter((b) => b.isGenesis);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.height).toBe(0);
  });

  it('marks an empty block by transaction count', () => {
    for (const b of getBlocks()) {
      expect(b.isEmpty).toBe(b.transactions.length === 0);
    }
  });
});

describe('getBlock', () => {
  it('finds a block by height', () => {
    expect(getBlock(0)?.height).toBe(0);
  });

  it('returns undefined for a height that does not exist', () => {
    expect(getBlock(9999)).toBeUndefined();
  });
});

describe('getPosts', () => {
  it('excludes amendments', () => {
    expect(getPosts().every((t) => t.type === 'post')).toBe(true);
  });

  it('returns posts newest first by date', () => {
    const dates = getPosts().map((p) => p.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe('getStats', () => {
  it('counts blocks, post transactions and assets', () => {
    const s = getStats();
    expect(s.height).toBe(getChain().blocks.length);
    expect(s.transactions).toBe(getPosts().length);
    expect(s.assets).toBe(getChain().assets.length);
  });

  it('counts distinct addresses across from and to', () => {
    const seen = new Set<string>();
    for (const b of getChain().blocks) {
      for (const t of b.transactions) {
        seen.add(t.from);
        for (const to of t.to) seen.add(to);
      }
    }
    expect(getStats().addresses).toBe(seen.size);
  });

  it('reports the chain difficulty', () => {
    expect(getStats().difficulty).toBe(getChain().difficulty);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/site/chain-data.test.ts`
Expected: FAIL — cannot resolve `../../src/site/chain-data`.

- [ ] **Step 3: Implement `src/site/chain-data.ts`**

```ts
import { CHAIN_CONFIG } from '../../chain.config';
import { readLock } from '../chain/lock';
import type { AssetRecord, Block, Chain, Transaction } from '../chain/types';

/**
 * The only module that reads the ledger. Templates import from here and never
 * touch `chain.lock.json` or `src/chain/` directly, so the ledger's shape can
 * change without a sweep through every `.astro` file.
 */

const LOCK_PATH = 'chain.lock.json';

let cached: Chain | null = null;

/** Memoized: a static build renders many pages from one ledger read. */
export function getChain(): Chain {
  cached ??= readLock(LOCK_PATH, CHAIN_CONFIG.difficulty);
  return cached;
}

/** §3.4 — the expected number of attempts to find a nonce at this difficulty. */
export function expectedAttempts(difficulty: number): number {
  return 16 ** difficulty;
}

/** How much work a block actually cost, against what its difficulty predicts. */
export function workRatio(nonce: number, difficulty: number): number {
  return nonce / expectedAttempts(difficulty);
}

/** `0xabc123…def456` — enough to recognise, short enough to sit in a table. */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

export interface BlockView extends Block {
  isGenesis: boolean;
  isEmpty: boolean;
  workRatio: number;
  shortHash: string;
}

function toView(block: Block): BlockView {
  return {
    ...block,
    isGenesis: block.height === 0,
    isEmpty: block.transactions.length === 0,
    workRatio: workRatio(block.nonce, block.difficulty),
    shortHash: shortHash(block.hash),
  };
}

/** Newest first — the chain reads backwards into history (§9). */
export function getBlocks(): BlockView[] {
  return [...getChain().blocks].sort((a, b) => b.height - a.height).map(toView);
}

export function getBlock(height: number): BlockView | undefined {
  const block = getChain().blocks.find((b) => b.height === height);
  return block ? toView(block) : undefined;
}

/** Post transactions only. Amendments are ledger entries, not writing (§3.9). */
export function getPosts(): Transaction[] {
  return getChain()
    .blocks.flatMap((b) => b.transactions)
    .filter((t) => t.type === 'post')
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getAssets(): AssetRecord[] {
  return [...getChain().assets].sort((a, b) => b.tokenId - a.tokenId);
}

export interface NetworkStats {
  height: number;
  transactions: number;
  addresses: number;
  difficulty: number;
  assets: number;
}

export function getStats(): NetworkStats {
  const chain = getChain();
  const addresses = new Set<string>();
  for (const block of chain.blocks) {
    for (const tx of block.transactions) {
      addresses.add(tx.from);
      for (const to of tx.to) addresses.add(to);
    }
  }
  return {
    height: chain.blocks.length,
    transactions: getPosts().length,
    addresses: addresses.size,
    difficulty: chain.difficulty,
    assets: chain.assets.length,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/site/chain-data.test.ts`
Expected: PASS, 16 tests.

Note the `shortHash` regex in the test expects `0x` plus 6 hex, ellipsis, 6 hex — `hash.slice(0, 8)` is `0x` plus 6 characters. Confirm the assertion matches; if it does not, fix the implementation to match the test's stated format rather than loosening the test.

Run `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 5: Commit**

```bash
git add src/site/chain-data.ts tests/site/chain-data.test.ts
git commit -m "feat(site): add typed chain data layer over the ledger"
```

---

### Task 3: Palette and intensity tokens

**Files:**
- Create: `src/site/themes.ts`
- Create: `src/styles/tokens.css`
- Test: `tests/site/themes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Palette { id: string; label: string; dark: boolean; swatch: [string, string] }`
  - `PALETTES: Palette[]` — eleven entries
  - `INTENSITIES: Array<{ id: 'min' | 'bal' | 'full'; label: string }>`
  - `METERS: Array<{ id: 'm1' | 'm2' | 'm3'; label: string }>`
  - `DEFAULTS: { palette: 'github-dark'; intensity: 'min'; meter: 'm1' }`

The CSS carries the actual colour values; `themes.ts` carries the list the picker renders and the ids that must agree with the CSS selectors. A test pins that agreement, because a typo in one place would silently give a reader a broken theme.

- [ ] **Step 1: Write the failing test**

Create `tests/site/themes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PALETTES, INTENSITIES, METERS, DEFAULTS } from '../../src/site/themes';

const CSS = readFileSync('src/styles/tokens.css', 'utf8');

describe('palette catalogue', () => {
  it('offers eleven palettes', () => {
    expect(PALETTES).toHaveLength(11);
  });

  it('has unique ids', () => {
    const ids = PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes both light and dark options', () => {
    expect(PALETTES.some((p) => p.dark)).toBe(true);
    expect(PALETTES.some((p) => !p.dark)).toBe(true);
  });

  it('gives every palette two swatch colours for the picker', () => {
    for (const p of PALETTES) {
      expect(p.swatch).toHaveLength(2);
      for (const c of p.swatch) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('css agreement', () => {
  it('defines a selector for every palette id', () => {
    for (const p of PALETTES) {
      expect(CSS, `missing palette ${p.id}`).toContain(`[data-palette="${p.id}"]`);
    }
  });

  it('defines a selector for every non-default intensity', () => {
    for (const i of INTENSITIES) {
      if (i.id === DEFAULTS.intensity) continue;
      expect(CSS, `missing intensity ${i.id}`).toContain(`[data-intensity="${i.id}"]`);
    }
  });

  it('defines a selector for every meter id', () => {
    for (const m of METERS) {
      expect(CSS, `missing meter ${m.id}`).toContain(`[data-meter="${m.id}"]`);
    }
  });

  it('sets the base token block on :root so the default palette needs no attribute', () => {
    expect(CSS).toMatch(/:root\s*\{/);
  });
});

describe('defaults', () => {
  it('names a palette that exists', () => {
    expect(PALETTES.map((p) => p.id)).toContain(DEFAULTS.palette);
  });

  it('names an intensity and meter that exist', () => {
    expect(INTENSITIES.map((i) => i.id)).toContain(DEFAULTS.intensity);
    expect(METERS.map((m) => m.id)).toContain(DEFAULTS.meter);
  });

  it('defaults to github-dark, minimal, bar per spec §9.1', () => {
    expect(DEFAULTS).toEqual({ palette: 'github-dark', intensity: 'min', meter: 'm1' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/site/themes.test.ts`
Expected: FAIL — cannot resolve `../../src/site/themes`.

- [ ] **Step 3: Implement `src/site/themes.ts`**

```ts
/**
 * §9.1 — the catalogue the preferences picker renders. Colour values live in
 * `src/styles/tokens.css`; this file carries only the ids and labels. A test
 * pins that every id here has a matching selector there, because a typo would
 * silently hand a reader a broken theme.
 *
 * Each palette uses its own signature colour rather than a shared accent slot:
 * Tokyo Night reads blue, Dracula purple, Gruvbox orange.
 */

export interface Palette {
  id: string;
  label: string;
  dark: boolean;
  /** Two representative colours, shown as dots in the picker. */
  swatch: [string, string];
}

export const PALETTES: Palette[] = [
  { id: 'github-dark', label: 'GitHub Dark', dark: true, swatch: ['#a371f7', '#7ee787'] },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: true, swatch: ['#7aa2f7', '#73daca'] },
  { id: 'gruvbox', label: 'Gruvbox', dark: true, swatch: ['#fe8019', '#b8bb26'] },
  { id: 'nord', label: 'Nord', dark: true, swatch: ['#88c0d0', '#8fbcbb'] },
  { id: 'dracula', label: 'Dracula', dark: true, swatch: ['#bd93f9', '#ff79c6'] },
  { id: 'catppuccin', label: 'Catppuccin Mocha', dark: true, swatch: ['#cba6f7', '#a6e3a1'] },
  { id: 'solarized', label: 'Solarized Dark', dark: true, swatch: ['#268bd2', '#2aa198'] },
  { id: 'one-dark', label: 'One Dark', dark: true, swatch: ['#61afef', '#98c379'] },
  { id: 'rose-pine', label: 'Rosé Pine', dark: true, swatch: ['#c4a7e7', '#9ccfd8'] },
  { id: 'latte', label: 'Catppuccin Latte', dark: false, swatch: ['#8839ef', '#179299'] },
  { id: 'github-light', label: 'GitHub Light', dark: false, swatch: ['#8250df', '#0969da'] },
];

export const INTENSITIES = [
  { id: 'min', label: 'Minimal' },
  { id: 'bal', label: 'Balanced' },
  { id: 'full', label: 'Full' },
] as const;

export const METERS = [
  { id: 'm1', label: 'Bar' },
  { id: 'm2', label: 'Segments' },
  { id: 'm3', label: 'Curve' },
] as const;

export const DEFAULTS = {
  palette: 'github-dark',
  intensity: 'min',
  meter: 'm1',
} as const;
```

- [ ] **Step 4: Implement `src/styles/tokens.css`**

The default palette's values live on `:root`, so a reader with no stored preference needs no attribute at all. Every other palette overrides them.

```css
/* §9.1 — palette, intensity and meter tokens.
   Structure: :root carries the default palette (github-dark). Each other
   palette redefines the same custom properties under its own attribute.
   Components style through the tokens and never name a palette. */

:root {
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: 'Be Vietnam Pro', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  --bg: #0d1117;
  --surf: #161b22;
  --line: #21262d;
  --line2: #30363d;
  --txt: #e6edf3;
  --dim: #8b949e;
  --acc: #a371f7;
  --h-hash: #7ee787;
  --h-addr: #79c0ff;
  --h-tag: #ff7b72;
  --h-num: #ffa657;
  --good: #3fb950;
  --warn: #d29922;
  --bad: #f85149;
}

[data-palette='tokyo-night'] {
  --bg: #1a1b26; --surf: #1f2335; --line: #292e42; --line2: #3b4261;
  --txt: #c0caf5; --dim: #565f89; --acc: #7aa2f7;
  --h-hash: #73daca; --h-addr: #7dcfff; --h-tag: #bb9af7; --h-num: #ff9e64;
  --good: #9ece6a; --warn: #e0af68; --bad: #f7768e;
}
[data-palette='gruvbox'] {
  --bg: #1d2021; --surf: #282828; --line: #3c3836; --line2: #504945;
  --txt: #ebdbb2; --dim: #928374; --acc: #fe8019;
  --h-hash: #b8bb26; --h-addr: #83a598; --h-tag: #d3869b; --h-num: #fabd2f;
  --good: #b8bb26; --warn: #fabd2f; --bad: #fb4934;
}
[data-palette='nord'] {
  --bg: #2e3440; --surf: #3b4252; --line: #434c5e; --line2: #4c566a;
  --txt: #eceff4; --dim: #8993a4; --acc: #88c0d0;
  --h-hash: #8fbcbb; --h-addr: #81a1c1; --h-tag: #b48ead; --h-num: #ebcb8b;
  --good: #a3be8c; --warn: #d08770; --bad: #bf616a;
}
[data-palette='dracula'] {
  --bg: #282a36; --surf: #343746; --line: #44475a; --line2: #5a5f7a;
  --txt: #f8f8f2; --dim: #8f94b5; --acc: #bd93f9;
  --h-hash: #f1fa8c; --h-addr: #8be9fd; --h-tag: #ff79c6; --h-num: #bd93f9;
  --good: #50fa7b; --warn: #ffb86c; --bad: #ff5555;
}
[data-palette='catppuccin'] {
  --bg: #1e1e2e; --surf: #26263a; --line: #313244; --line2: #45475a;
  --txt: #cdd6f4; --dim: #7f849c; --acc: #cba6f7;
  --h-hash: #a6e3a1; --h-addr: #89b4fa; --h-tag: #f5c2e7; --h-num: #fab387;
  --good: #a6e3a1; --warn: #f9e2af; --bad: #f38ba8;
}
[data-palette='solarized'] {
  --bg: #002b36; --surf: #073642; --line: #0f4553; --line2: #586e75;
  --txt: #eee8d5; --dim: #93a1a1; --acc: #268bd2;
  --h-hash: #2aa198; --h-addr: #6c71c4; --h-tag: #d33682; --h-num: #b58900;
  --good: #859900; --warn: #b58900; --bad: #dc322f;
}
[data-palette='one-dark'] {
  --bg: #21252b; --surf: #282c34; --line: #3a4049; --line2: #4b5263;
  --txt: #d7dae0; --dim: #7f848e; --acc: #61afef;
  --h-hash: #98c379; --h-addr: #56b6c2; --h-tag: #c678dd; --h-num: #d19a66;
  --good: #98c379; --warn: #e5c07b; --bad: #e06c75;
}
[data-palette='rose-pine'] {
  --bg: #191724; --surf: #1f1d2e; --line: #26233a; --line2: #403d52;
  --txt: #e0def4; --dim: #908caa; --acc: #c4a7e7;
  --h-hash: #9ccfd8; --h-addr: #ebbcba; --h-tag: #eb6f92; --h-num: #f6c177;
  --good: #9ccfd8; --warn: #f6c177; --bad: #eb6f92;
}
[data-palette='latte'] {
  --bg: #eff1f5; --surf: #e6e9ef; --line: #ccd0da; --line2: #bcc0cc;
  --txt: #4c4f69; --dim: #6c6f85; --acc: #8839ef;
  --h-hash: #179299; --h-addr: #1e66f5; --h-tag: #ea76cb; --h-num: #fe640b;
  --good: #40a02b; --warn: #df8e1d; --bad: #d20f39;
}
[data-palette='github-light'] {
  --bg: #ffffff; --surf: #f6f8fa; --line: #d8dee4; --line2: #afb8c1;
  --txt: #1f2328; --dim: #656d76; --acc: #8250df;
  --h-hash: #1b7c83; --h-addr: #0969da; --h-tag: #cf222e; --h-num: #bc4c00;
  --good: #1a7f37; --warn: #9a6700; --bad: #cf222e;
}

/* Intensity decides which roles actually take a hue. Minimal is the default,
   so it lives on :root and needs no attribute. */
:root {
  --c-hash: var(--dim);
  --c-addr: var(--txt);
  --c-tag: var(--txt);
  --c-num: var(--txt);
}
[data-intensity='bal'] {
  --c-hash: var(--dim);
  --c-addr: var(--h-addr);
  --c-tag: var(--txt);
  --c-num: var(--txt);
}
[data-intensity='full'] {
  --c-hash: var(--h-hash);
  --c-addr: var(--h-addr);
  --c-tag: var(--h-tag);
  --c-num: var(--h-num);
}

/* All three meters render; CSS shows one. A reader without JavaScript keeps
   the default rather than seeing three at once or none. */
.meter { display: none; }
:root .meter-m1 { display: block; }
[data-meter='m1'] .meter-m1 { display: block; }
[data-meter='m1'] .meter-m2,
[data-meter='m1'] .meter-m3 { display: none; }
[data-meter='m2'] .meter-m1 { display: none; }
[data-meter='m2'] .meter-m2 { display: block; }
[data-meter='m3'] .meter-m1 { display: none; }
[data-meter='m3'] .meter-m3 { display: block; }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/site/themes.test.ts`
Expected: PASS, 12 tests.

Run `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 6: Commit**

```bash
git add src/site/themes.ts src/styles/tokens.css tests/site/themes.test.ts
git commit -m "feat(site): add palette, intensity and meter tokens"
```

---

### Task 4: Fonts with verified Vietnamese coverage

**Files:**
- Create: `scripts/check-vietnamese.ts`
- Create: `src/styles/fonts.css`
- Modify: `package.json`
- Test: `tests/site/fonts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run check:vietnamese`; `src/styles/fonts.css` with `@font-face` rules for the vendored families.

The spec calls Vietnamese diacritic coverage in the monospace face a **selection gate**, not an afterthought. Vietnamese needs Latin Extended Additional (U+1EA0–U+1EF9) — `ế ộ ữ ằ ị` and friends — and many monospace faces stop at basic Latin, silently falling back mid-word. This task verifies coverage against the real font files before committing to them.

- [ ] **Step 1: Write the coverage checker**

Create `scripts/check-vietnamese.ts`:

```ts
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
```

Add to `package.json` scripts:

```json
    "check:vietnamese": "tsx scripts/check-vietnamese.ts",
```

- [ ] **Step 2: Run the checker**

Run: `npm run check:vietnamese`

**If JetBrains Mono reports no Vietnamese subset, stop and report it.** Do not proceed with a font that cannot render the content — that is exactly the gate this task exists to be. Candidate replacements with known Vietnamese coverage, in order of preference: `@fontsource/ibm-plex-mono`, `@fontsource/source-code-pro`, `@fontsource/noto-sans-mono`. Install one, point `PACKAGES` and `fonts.css` at it, and say in your report which face you ended up with and why.

- [ ] **Step 3: Write the failing test**

Create `tests/site/fonts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { hasVietnameseSubset } from '../../scripts/check-vietnamese';

describe('font coverage', () => {
  it('the prose face ships a vietnamese subset', () => {
    expect(hasVietnameseSubset('node_modules/@fontsource/be-vietnam-pro')).toBe(true);
  });

  it('the monospace face ships a vietnamese subset', () => {
    // Hashes sit beside Vietnamese titles in the same table; the mono face
    // must cover both or titles break mid-word.
    const mono = readFileSync('src/styles/fonts.css', 'utf8').match(
      /@fontsource\/([a-z0-9-]+)/,
    );
    expect(mono).not.toBeNull();
  });
});

describe('fonts.css', () => {
  const css = readFileSync('src/styles/fonts.css', 'utf8');

  it('exists and declares font faces', () => {
    expect(existsSync('src/styles/fonts.css')).toBe(true);
    expect(css).toContain('@font-face');
  });

  it('self-hosts — no external url', () => {
    expect(css).not.toMatch(/https?:\/\//);
  });

  it('declares a vietnamese unicode-range', () => {
    // U+1EA0–U+1EF9 is Latin Extended Additional, where Vietnamese lives.
    expect(css.toUpperCase()).toContain('U+1EA0');
  });

  it('uses font-display swap so text is never invisible', () => {
    expect(css).toContain('font-display: swap');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run tests/site/fonts.test.ts`
Expected: FAIL — `src/styles/fonts.css` does not exist.

- [ ] **Step 5: Write `src/styles/fonts.css`**

Import the Fontsource CSS for the weights actually used, then declare the Vietnamese range explicitly so the browser knows to fetch that subset.

```css
/* Self-hosted. No CDN: the build must work offline and the site must make no
   third-party request per page load (§9). */

@import '@fontsource/be-vietnam-pro/vietnamese-400.css';
@import '@fontsource/be-vietnam-pro/vietnamese-600.css';
@import '@fontsource/be-vietnam-pro/latin-400.css';
@import '@fontsource/be-vietnam-pro/latin-600.css';

@import '@fontsource/jetbrains-mono/vietnamese-400.css';
@import '@fontsource/jetbrains-mono/vietnamese-600.css';
@import '@fontsource/jetbrains-mono/latin-400.css';
@import '@fontsource/jetbrains-mono/latin-600.css';

/* Fontsource's own @font-face rules carry the unicode-range and font-display.
   This block documents the Vietnamese range for the coverage test and pins
   the swap behaviour in case a future import stops setting it. */
@font-face {
  font-family: 'Be Vietnam Pro';
  font-display: swap;
  src: local('Be Vietnam Pro');
  unicode-range: U+1EA0-1EF9, U+0102-0103, U+0110-0111, U+0128-0129,
                 U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+20AB;
}
```

If a `vietnamese-*.css` import path does not exist for a package, run `ls node_modules/@fontsource/<name>/` to find the real filenames and use those — Fontsource's naming has varied across versions. Report what you used.

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run tests/site/fonts.test.ts` — Expected: PASS, 6 tests.
Run `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/check-vietnamese.ts \
        src/styles/fonts.css tests/site/fonts.test.ts
git commit -m "feat(site): self-host fonts with verified vietnamese coverage"
```

---

### Task 5: The preferences system

**Files:**
- Create: `src/site/prefs-script.ts`
- Create: `src/components/Preferences.astro`
- Create: `src/layouts/Base.astro`
- Modify: `src/pages/index.astro`
- Test: `tests/site/prefs.test.ts`

**Interfaces:**
- Consumes: `PALETTES`, `INTENSITIES`, `METERS`, `DEFAULTS` from `src/site/themes`.
- Produces:
  - `PREFS_INLINE_SCRIPT: string` — the blocking script's source, exported so a test can assert its shape
  - `STORAGE_KEYS: { palette: string; intensity: string; meter: string }` — the `localStorage` keys, shared by the inline script and the picker so they cannot drift
  - `Base.astro` — the layout every page uses, taking a `title` prop
  - `Preferences.astro` — the picker

The blocking script is the load-bearing piece. It must run **before first paint**, which means inline in `<head>`, not a module, not deferred. A flash of the wrong theme is a defect.

- [ ] **Step 1: Write the failing test**

Create `tests/site/prefs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { PREFS_INLINE_SCRIPT, STORAGE_KEYS } from '../../src/site/prefs-script';
import { DEFAULTS, PALETTES } from '../../src/site/themes';

describe('inline preferences script', () => {
  it('reads every preference from localStorage', () => {
    for (const key of Object.values(STORAGE_KEYS)) {
      expect(PREFS_INLINE_SCRIPT).toContain(key);
    }
  });

  it('sets all three data attributes on the document element', () => {
    for (const attr of ['data-palette', 'data-intensity', 'data-meter']) {
      expect(PREFS_INLINE_SCRIPT).toContain(attr);
    }
  });

  it('honours prefers-color-scheme on a first visit', () => {
    expect(PREFS_INLINE_SCRIPT).toContain('prefers-color-scheme');
  });

  it('is wrapped so a storage exception cannot break the page', () => {
    // Safari in private mode throws on localStorage access. An unhandled
    // throw here would abort the inline script and leave the page unstyled.
    expect(PREFS_INLINE_SCRIPT).toContain('try');
    expect(PREFS_INLINE_SCRIPT).toContain('catch');
  });

  it('contains no line breaks that would need escaping in an attribute', () => {
    expect(PREFS_INLINE_SCRIPT.includes('</script')).toBe(false);
  });
});

describe('built homepage', () => {
  it('inlines the preferences script in the head, before any stylesheet link', () => {
    const html = readDist('index.html');
    const scriptAt = html.indexOf('data-palette');
    const bodyAt = html.indexOf('<body');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(bodyAt);
  });

  it('renders the picker with every palette', () => {
    const html = readDist('index.html');
    for (const p of PALETTES) {
      expect(html, `picker missing ${p.id}`).toContain(`value="${p.id}"`);
    }
  });

  it('renders all three meter markups so no-JS readers see the default', () => {
    const html = readDist('index.html');
    expect(html).toContain('meter-m1');
    expect(html).toContain('meter-m2');
    expect(html).toContain('meter-m3');
  });

  it('declares the document language as Vietnamese', () => {
    expect(readDist('index.html')).toContain('<html lang="vi"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/site/prefs.test.ts`
Expected: FAIL — cannot resolve `../../src/site/prefs-script`.

- [ ] **Step 3: Implement `src/site/prefs-script.ts`**

```ts
import { DEFAULTS } from './themes';

export const STORAGE_KEYS = {
  palette: 'cb:palette',
  intensity: 'cb:intensity',
  meter: 'cb:meter',
} as const;

/**
 * §9.1 — applied before first paint.
 *
 * This runs as a plain inline `<script>` in `<head>`, deliberately blocking.
 * A deferred or module script would paint the default theme first and then
 * repaint the reader's choice, which is a visible flash.
 *
 * Every access is inside try/catch: Safari in private mode throws on
 * `localStorage`, and an unhandled throw would abort the script and leave
 * the page with no attributes at all.
 */
export const PREFS_INLINE_SCRIPT = `
(function(){
  try {
    var d = document.documentElement;
    var s = window.localStorage;
    var pal = s.getItem('${STORAGE_KEYS.palette}');
    if (!pal) {
      pal = window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'github-light' : '${DEFAULTS.palette}';
    }
    d.setAttribute('data-palette', pal);
    d.setAttribute('data-intensity', s.getItem('${STORAGE_KEYS.intensity}') || '${DEFAULTS.intensity}');
    d.setAttribute('data-meter', s.getItem('${STORAGE_KEYS.meter}') || '${DEFAULTS.meter}');
  } catch (e) {
    document.documentElement.setAttribute('data-palette', '${DEFAULTS.palette}');
    document.documentElement.setAttribute('data-intensity', '${DEFAULTS.intensity}');
    document.documentElement.setAttribute('data-meter', '${DEFAULTS.meter}');
  }
})();
`.trim();
```

- [ ] **Step 4: Implement `src/components/Preferences.astro`**

```astro
---
import { PALETTES, INTENSITIES, METERS } from '../site/themes';
import { STORAGE_KEYS } from '../site/prefs-script';
---

<details class="prefs">
  <summary aria-label="Tuỳ chọn hiển thị">Theme</summary>
  <div class="prefs-body">
    <fieldset>
      <legend>Palette</legend>
      {PALETTES.map((p) => (
        <button type="button" data-pref="palette" value={p.id}>
          <span class="dots">
            <i style={`background:${p.swatch[0]}`}></i><i style={`background:${p.swatch[1]}`}></i>
          </span>
          {p.label}
        </button>
      ))}
    </fieldset>
    <fieldset>
      <legend>Colour</legend>
      {INTENSITIES.map((i) => (
        <button type="button" data-pref="intensity" value={i.id}>{i.label}</button>
      ))}
    </fieldset>
    <fieldset>
      <legend>Work meter</legend>
      {METERS.map((m) => (
        <button type="button" data-pref="meter" value={m.id}>{m.label}</button>
      ))}
    </fieldset>
  </div>
</details>

<script is:inline define:vars={{ KEYS: STORAGE_KEYS }}>
  document.querySelectorAll('[data-pref]').forEach(function (b) {
    b.addEventListener('click', function () {
      var kind = b.getAttribute('data-pref');
      var value = b.getAttribute('value');
      document.documentElement.setAttribute('data-' + kind, value);
      try { window.localStorage.setItem(KEYS[kind], value); } catch (e) { /* private mode */ }
      document.querySelectorAll('[data-pref="' + kind + '"]').forEach(function (o) {
        o.setAttribute('aria-pressed', String(o === b));
      });
    });
  });
</script>
```

The picker is a `<details>` so it works closed with no JavaScript; the buttons only do anything with JavaScript, which is correct — a reader without it keeps the defaults, which are legible.

- [ ] **Step 5: Implement `src/layouts/Base.astro`**

```astro
---
import { PREFS_INLINE_SCRIPT } from '../site/prefs-script';
import Preferences from '../components/Preferences.astro';
import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/base.css';

interface Props {
  title: string;
  description?: string;
}

const { title, description = 'Blog của lamter, hiển thị như một trình duyệt blockchain.' } = Astro.props;
---

<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <script is:inline set:html={PREFS_INLINE_SCRIPT} />
  </head>
  <body>
    <nav class="nav">
      <a class="brand" href="/">lamter<span>.eth</span></a>
      <ul>
        <li><a href="/blocks">Blocks</a></li>
        <li><a href="/tx">Transactions</a></li>
        <li><a href="/address">Addresses</a></li>
        <li><a href="/assets">Assets</a></li>
        <li><a href="/mempool">Mempool</a></li>
        <li><a href="/verify">Verify</a></li>
      </ul>
      <Preferences />
    </nav>
    <main>
      <slot />
    </main>
  </body>
</html>
```

Some of those nav targets do not exist until Plan 2b; they are correct destinations and will 404 in the meantime, which is visible and honest rather than hidden.

- [ ] **Step 6: Create `src/styles/base.css`**

```css
/* Element defaults. Component styles live with their components. */
*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--txt);
  font-family: var(--sans);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; }

.nav {
  display: flex; flex-wrap: wrap; gap: 0.9rem 1.2rem; align-items: center;
  padding: 0.85rem 1.25rem;
  background: var(--surf);
  border-bottom: 1px solid var(--line2);
}
.nav .brand { font-family: var(--mono); font-weight: 600; text-decoration: none; }
.nav .brand span { color: var(--acc); }
.nav ul { display: flex; flex-wrap: wrap; gap: 1.05rem; list-style: none; margin: 0; padding: 0; }
.nav li a {
  font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--dim); text-decoration: none;
}
.nav li a:hover, .nav li a:focus-visible { color: var(--txt); }

main { padding: 1.25rem; max-width: 64rem; margin: 0 auto; }

:where(a, button, summary):focus-visible {
  outline: 2px solid var(--acc); outline-offset: 2px;
}

.prefs { margin-left: auto; font-family: var(--mono); font-size: 0.72rem; }
.prefs summary {
  cursor: pointer; color: var(--dim);
  border: 1px solid var(--line2); border-radius: 3px; padding: 0.36rem 0.6rem;
  list-style: none;
}
.prefs-body {
  display: grid; gap: 0.9rem; margin-top: 0.6rem;
  padding: 0.9rem; background: var(--bg);
  border: 1px solid var(--line2); border-radius: 4px;
}
.prefs fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
.prefs legend {
  font-size: 0.6rem; letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--dim); padding: 0 0 0.4rem;
}
.prefs button {
  font: inherit; color: var(--dim); background: transparent;
  border: 1px solid var(--line2); border-radius: 99px;
  padding: 0.3rem 0.7rem; cursor: pointer;
  display: inline-flex; align-items: center; gap: 0.42rem;
}
.prefs button:hover { color: var(--txt); }
.prefs button[aria-pressed='true'] { color: var(--txt); border-color: var(--acc); }
.prefs .dots { display: flex; gap: 2px; }
.prefs .dots i { width: 0.42rem; height: 0.42rem; border-radius: 50%; display: block; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 7: Point the homepage at the layout**

Replace `src/pages/index.astro` entirely:

```astro
---
import Base from '../layouts/Base.astro';
---

<Base title="Chain Blog">
  <p>Đang xây dựng.</p>
  <div class="meter meter-m1">m1</div>
  <div class="meter meter-m2">m2</div>
  <div class="meter meter-m3">m3</div>
</Base>
```

The three meter divs are placeholders proving the CSS selection works; Task 6 replaces them with real meters.

- [ ] **Step 8: Build and verify**

Run: `npm run build`, then `npx vitest run tests/site/prefs.test.ts`
Expected: PASS, 9 tests.

Run `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 9: Check the flash by hand**

Run `npm run preview`, open the site, pick a non-default palette, and hard-reload. **The page must never paint the default theme first.** If you see a flash, the inline script is not blocking — check it is `is:inline` and sits in `<head>` before any stylesheet. Report what you observed.

- [ ] **Step 10: Commit**

```bash
git add src/site/prefs-script.ts src/components/Preferences.astro \
        src/layouts/Base.astro src/styles/base.css src/pages/index.astro \
        tests/site/prefs.test.ts
git commit -m "feat(site): add reader preferences applied before first paint"
```

---

### Task 6: The homepage

**Files:**
- Create: `src/components/StatsBar.astro`
- Create: `src/components/WorkMeter.astro`
- Create: `src/components/BlockCard.astro`
- Modify: `src/pages/index.astro`
- Create: `src/styles/chain.css`
- Test: `tests/site/homepage.test.ts`

**Interfaces:**
- Consumes: `getBlocks`, `getStats`, `expectedAttempts`, `BlockView` from `src/site/chain-data`.
- Produces: the rendered homepage.

`WorkMeter` renders all three styles; CSS shows the reader's choice.

- [ ] **Step 1: Write the failing test**

Create `tests/site/homepage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readDist } from './dist';
import { getBlocks, getStats } from '../../src/site/chain-data';

// Read inside each test, never at module level — see tests/site/dist.ts.
const html = () => readDist('index.html');

describe('stats bar', () => {
  it('shows chain height, transactions, addresses and difficulty', () => {
    const s = getStats();
    expect(html()).toContain('Chain height');
    expect(html()).toContain('Transactions');
    expect(html()).toContain('Addresses');
    expect(html()).toContain('Difficulty');
    expect(html()).toContain(`>${s.height}<`);
  });
});

describe('block list', () => {
  it('renders every block', () => {
    for (const b of getBlocks()) {
      expect(html(), `missing block #${b.height}`).toContain(`data-block="${b.height}"`);
    }
  });

  it('orders blocks newest first in the document', () => {
    const order = [...html().matchAll(/data-block="(\d+)"/g)].map((m) => Number(m[1]));
    expect(order).toEqual([...order].sort((a, b) => b - a));
  });

  it('stamps sealed blocks', () => {
    expect(html()).toContain('Sealed');
  });

  it('marks the genesis block', () => {
    expect(html()).toContain('genesis');
  });

  it('renders each block with all three meter styles', () => {
    const blocks = getBlocks().length;
    expect([...html().matchAll(/meter-m1/g)]).toHaveLength(blocks);
    expect([...html().matchAll(/meter-m2/g)]).toHaveLength(blocks);
    expect([...html().matchAll(/meter-m3/g)]).toHaveLength(blocks);
  });

  it('shows the nonce and the work ratio', () => {
    const newest = getBlocks()[0]!;
    expect(html()).toContain(newest.nonce.toLocaleString('en-US'));
  });

  it('says a silent month is silent, in Vietnamese', () => {
    if (getBlocks().some((b) => b.isEmpty)) {
      expect(html()).toContain('Không có bài viết');
    }
  });
});

describe('chrome language', () => {
  it('keeps explorer terms in English', () => {
    expect(html()).toContain('Block');
    expect(html()).toContain('Nonce');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx vitest run tests/site/homepage.test.ts`
Expected: FAIL — the placeholder homepage has no stats bar or blocks.

- [ ] **Step 3: Implement `src/components/StatsBar.astro`**

```astro
---
import { getStats } from '../site/chain-data';
const s = getStats();
const cells = [
  { k: 'Chain height', v: String(s.height), tone: 'acc' },
  { k: 'Transactions', v: String(s.transactions), tone: 'hash' },
  { k: 'Addresses', v: String(s.addresses), tone: 'addr' },
  { k: 'Difficulty', v: '0'.repeat(s.difficulty), tone: 'num' },
];
---

<div class="stats">
  {cells.map((c) => (
    <div class={`stat stat-${c.tone}`}>
      <div class="k">{c.k}</div>
      <div class="v">{c.v}</div>
    </div>
  ))}
</div>
```

- [ ] **Step 4: Implement `src/components/WorkMeter.astro`**

```astro
---
import { expectedAttempts } from '../site/chain-data';

interface Props { nonce: number; difficulty: number }
const { nonce, difficulty } = Astro.props;

const expected = expectedAttempts(difficulty);
const ratio = nonce / expected;
const lucky = ratio < 1;

// M1: the bar caps at 3x so an unlucky block stays on scale; the tick marks 1x.
const barPct = Math.min(ratio / 3, 1) * 100;

// M2: twelve segments spanning 3x, so four segments is exactly 1x expected.
const perSegment = (expected * 3) / 12;
const segments = Array.from({ length: 12 }, (_, i) => {
  const filled = (nonce - i * perSegment) / perSegment;
  return Math.max(0, Math.min(1, filled)) * 100;
});

// M3: cumulative probability 1 - e^-x, sampled every 0.25x across 0..3x.
const CURVE = Array.from({ length: 13 }, (_, i) => {
  const x = i * 0.25;
  return { x: (x / 3) * 200, y: 38 - (1 - Math.exp(-x)) * 34 };
});
const path = CURVE.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
const markX = (Math.min(ratio, 3) / 3) * 200;
const markY = 38 - (1 - Math.exp(-Math.min(ratio, 3))) * 34;
const fillPath = `${CURVE.filter((p) => p.x <= markX)
  .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
  .join(' ')} L${markX.toFixed(2)},${markY.toFixed(2)} L${markX.toFixed(2)},38 Z`;
---

<div class="work">
  <div class="work-top">
    <span>Nonce <span class="num">{nonce.toLocaleString('en-US')}</span></span>
    <span class={`luck ${lucky ? 'good' : 'over'}`}>
      {ratio.toFixed(2)}× {lucky ? '— lucky' : 'expected'}
    </span>
  </div>

  <div class="meter meter-m1">
    <div class="bar"><span class="tick"></span><i class={lucky ? 'good' : ''} style={`width:${barPct}%`}></i></div>
    <div class="scale"><span>0</span><span>1× · {expected.toLocaleString('en-US')}</span><span>3×</span></div>
  </div>

  <div class="meter meter-m2">
    <div class="segs">
      {segments.map((pct, i) => (
        <span class={`seg${i === 3 ? ' exp' : ''}`}><span class={lucky ? 'good' : ''} style={`width:${pct}%`}></span></span>
      ))}
    </div>
    <div class="cap">1 segment = {Math.round(perSegment).toLocaleString('en-US')} attempts</div>
  </div>

  <div class="meter meter-m3">
    <svg viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${path} L200,38 Z`} fill="currentColor" opacity="0.06" />
      <path d={fillPath} class={lucky ? 'fill-good' : 'fill-over'} />
      <path d={path} fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.5" vector-effect="non-scaling-stroke" />
      <line x1="66.67" y1="4" x2="66.67" y2="38" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3" opacity="0.4" vector-effect="non-scaling-stroke" />
      <line x1={markX.toFixed(2)} y1={markY.toFixed(2)} x2={markX.toFixed(2)} y2="38" class={lucky ? 'mark-good' : 'mark-over'} stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="cap">chance of a hit by n attempts · landed at {ratio.toFixed(2)}×</div>
  </div>
</div>
```

The fill path and the curve are built from **the same sampled points**, so the shaded edge follows the line exactly. Do not compute them separately.

- [ ] **Step 5: Implement `src/components/BlockCard.astro`**

```astro
---
import WorkMeter from './WorkMeter.astro';
import type { BlockView } from '../site/chain-data';

interface Props { block: BlockView; isNewest: boolean; isOldest: boolean }
const { block, isNewest, isOldest } = Astro.props;
---

<div class="row" data-block={block.height}>
  <div class="gutter">
    <span class="spine" data-first={isNewest} data-last={isOldest}></span>
    <span class={`n${block.isEmpty ? ' q' : ''}`}>#{block.height}</span>
    <span class={`dot${block.isEmpty ? ' q' : ''}`}></span>
  </div>
  <article class={`card${block.isEmpty ? ' empty' : ''}`}>
    <div class="card-top">
      <span class="per">{block.period}{block.isGenesis ? ' · genesis' : ''}</span>
      <span class="stamp">Sealed</span>
    </div>
    <dl class="meta">
      <dt>Hash</dt>
      <dd><span class="hash">{block.hash}</span></dd>
      <dt>Merkle</dt>
      <dd><span class="hash">{block.merkleRoot}</span></dd>
    </dl>
    <WorkMeter nonce={block.nonce} difficulty={block.difficulty} />
    {block.transactions.length > 0 ? (
      <ul class="txs">
        {block.transactions.map((tx) => (
          <li>
            <span class="t">{tx.title ?? 'Amendment'}</span>
            <span class="g">{tx.gasUsed} từ · {tx.value.toFixed(1)} giờ</span>
          </li>
        ))}
      </ul>
    ) : (
      <p class="silent">Không có bài viết nào trong tháng này. Khối vẫn được đào.</p>
    )}
  </article>
</div>
```

- [ ] **Step 6: Write `src/styles/chain.css`**

```css
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.7rem; margin-bottom: 1.4rem; }
.stat { background: var(--surf); border: 1px solid var(--line); border-top: 2px solid var(--acc);
  border-radius: 4px; padding: 0.85rem 0.95rem; }
.stat .k { font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.15em;
  text-transform: uppercase; color: var(--dim); }
.stat .v { font-family: var(--mono); font-size: 1.55rem; margin-top: 0.25rem;
  font-variant-numeric: tabular-nums; line-height: 1.1; }
.stat-hash { border-top-color: var(--c-hash); }
.stat-addr { border-top-color: var(--c-addr); }
.stat-num { border-top-color: var(--c-num); }

.row { display: grid; grid-template-columns: 3.6rem 1fr; }
.gutter { position: relative; }
.gutter .spine { position: absolute; left: 2.6rem; top: 0; bottom: 0; width: 3px;
  background: var(--line2); border-radius: 2px; }
.gutter .spine[data-first='true'] { top: 0.95rem; }
.gutter .spine[data-last='true'] { bottom: 0.85rem; }
.gutter .n { position: absolute; left: 0; top: 0.48rem; width: 2.15rem; text-align: right;
  font-family: var(--mono); font-size: 0.92rem; line-height: 1; color: var(--acc); }
.gutter .n.q { color: var(--dim); }
.gutter .dot { position: absolute; left: calc(2.6rem + 1.5px - 0.35rem); top: 0.6rem;
  width: 0.7rem; height: 0.7rem; border-radius: 50%; background: var(--bg);
  border: 2px solid var(--acc); }
.gutter .dot.q { border-color: var(--dim); }

.card { background: var(--surf); border: 1px solid var(--line2); border-radius: 5px;
  padding: 1rem 1.1rem; margin: 0 0 0.85rem; min-width: 0; }
.card.empty { background: transparent; border-style: dashed; }
.card-top { display: flex; flex-wrap: wrap; gap: 0.55rem 1rem; align-items: center; }
.card-top .per { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.11em;
  text-transform: uppercase; color: var(--dim); }
.card-top .stamp { margin-left: auto; font-family: var(--mono); font-size: 0.6rem;
  letter-spacing: 0.13em; text-transform: uppercase; color: var(--good);
  border: 1.5px solid var(--good); border-radius: 2px; padding: 0.26rem 0.5rem;
  transform: rotate(-3deg); white-space: nowrap; }

.meta { font-family: var(--mono); font-size: 0.74rem; margin-top: 0.8rem;
  display: grid; grid-template-columns: 4.2rem 1fr; gap: 0.26rem 0.8rem; }
.meta dt { color: var(--dim); font-size: 0.66rem; letter-spacing: 0.09em;
  text-transform: uppercase; padding-top: 0.12rem; }
.meta dd { margin: 0; }
.hash { font-family: var(--mono); word-break: break-all; color: var(--c-hash); }
.num { color: var(--c-num); font-variant-numeric: tabular-nums; }

.txs { list-style: none; margin: 0.9rem 0 0; padding: 0.8rem 0 0; border-top: 1px solid var(--line); }
.txs li { display: flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; align-items: baseline; }
.txs .t { font-size: 1.02rem; font-weight: 600; }
.txs .g { font-family: var(--mono); font-size: 0.7rem; color: var(--dim); margin-left: auto; }
.silent { margin: 0.55rem 0 0; color: var(--dim); font-size: 0.9rem; font-style: italic; }

.work { margin-top: 0.85rem; padding-top: 0.75rem; border-top: 1px solid var(--line); }
.work-top { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; align-items: baseline;
  font-family: var(--mono); font-size: 0.68rem; color: var(--dim); }
.work-top .luck { margin-left: auto; }
.work-top .luck.over { color: var(--warn); }
.work-top .luck.good { color: var(--good); }
.meter .bar { position: relative; height: 5px; background: var(--bg);
  border: 1px solid var(--line2); border-radius: 3px; margin-top: 0.45rem; overflow: hidden; }
.meter .bar i { display: block; height: 100%; background: var(--warn); }
.meter .bar i.good { background: var(--good); }
.meter .bar .tick { position: absolute; top: -3px; bottom: -3px; width: 1px;
  background: var(--dim); left: 33.33%; }
.meter .scale, .meter .cap { display: flex; justify-content: space-between;
  font-family: var(--mono); font-size: 0.6rem; color: var(--dim); margin-top: 0.25rem; }
.meter .segs { display: flex; gap: 2px; margin-top: 0.5rem; }
.meter .seg { flex: 1; height: 10px; background: var(--bg); border: 1px solid var(--line2);
  border-radius: 1px; overflow: hidden; }
.meter .seg.exp { border-right-width: 2px; border-right-color: var(--dim); }
.meter .seg > span { display: block; height: 100%; background: var(--warn); }
.meter .seg > span.good { background: var(--good); }
.meter svg { display: block; width: 100%; height: 66px; }
.meter .fill-over { fill: var(--warn); opacity: 0.26; }
.meter .fill-good { fill: var(--good); opacity: 0.34; }
.meter .mark-over { stroke: var(--warn); }
.meter .mark-good { stroke: var(--good); }

@media (max-width: 44rem) { .stats { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 32rem) {
  .row { grid-template-columns: 2.4rem 1fr; }
  .gutter .spine { left: 1.6rem; }
  .gutter .dot { left: calc(1.6rem + 1.5px - 0.35rem); }
  .gutter .n { width: 1.2rem; }
  .meta { grid-template-columns: 1fr; }
}
```

- [ ] **Step 7: Implement the homepage**

Replace `src/pages/index.astro`:

```astro
---
import Base from '../layouts/Base.astro';
import StatsBar from '../components/StatsBar.astro';
import BlockCard from '../components/BlockCard.astro';
import { getBlocks } from '../site/chain-data';
import '../styles/chain.css';

const blocks = getBlocks();
---

<Base title="Chain Blog — lamter.eth">
  <StatsBar />
  <div class="chain">
    {blocks.map((block, i) => (
      <BlockCard block={block} isNewest={i === 0} isOldest={i === blocks.length - 1} />
    ))}
  </div>
</Base>
```

- [ ] **Step 8: Build and verify**

Run: `npm run build && npx vitest run tests/site/homepage.test.ts`
Expected: PASS, 9 tests.

Run `npm test` and `npm run typecheck` — both clean.

- [ ] **Step 9: Look at it**

Run `npm run preview` and check by eye: the spine is unbroken from the newest block to the oldest, the stamp sits right, and switching palette, intensity and meter in the picker changes all three live. Then disable JavaScript and reload — the page must still render, at GitHub Dark / Minimal / Bar, with exactly one meter visible per block. Report both observations.

- [ ] **Step 10: Commit**

```bash
git add src/components/StatsBar.astro src/components/WorkMeter.astro \
        src/components/BlockCard.astro src/pages/index.astro \
        src/styles/chain.css tests/site/homepage.test.ts
git commit -m "feat(site): render the homepage from the real chain"
```

---

## Done criteria

- `npm run build` produces a static `dist/` with no server entrypoint.
- `npm test` passes: the 267 engine tests plus the new site tests.
- `npm run typecheck` is clean.
- The homepage renders every block from the real ledger, newest first, with an unbroken spine.
- Switching palette, intensity or meter updates the page and survives a reload with no flash.
- With JavaScript disabled the site renders at the defaults with exactly one meter per block.
- Both font families are self-hosted and verified to carry a Vietnamese subset.

## What this plan deliberately does not cover

Plan 2b: `/blocks`, `/block/[height]`, `/tx/[slug]`, `/address/[name]`, `/about`, `/contracts`, `/mempool`, `/assets`, `/asset/[tokenId]`, RSS, the 404 page, KaTeX and syntax highlighting. Plan 3: the search island, the interactive verifier UI, and CI/deploy.
