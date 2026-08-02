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
