import { DEFAULTS } from './themes';

export const STORAGE_KEYS = {
  palette: 'bc:palette',
  intensity: 'bc:intensity',
  meter: 'bc:meter',
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
