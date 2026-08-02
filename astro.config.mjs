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
