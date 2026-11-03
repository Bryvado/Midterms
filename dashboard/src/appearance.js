import { runMapUpdate } from './map-loading.js';
import { setTheme } from './map.js';

// Basemap (light, dark or roads only) and the data-panel theme, set from the Basemap section of Map controls.
// Roads only uses the plain background that matches the panel theme.
export function initAppearance() {
  const key = 'tx-appearance-v1', preferences = { basemap:'light', layout:'light' };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    // Older saves kept a style name in `map`; plain and highways-only backgrounds become roads only.
    const map = saved?.basemap ?? saved?.map;
    if (['light', 'dark'].includes(map)) preferences.basemap = map;
    else if (/^(plain|roads)/.test(map || '')) preferences.basemap = 'roads';
    if (['light', 'dark'].includes(saved?.layout)) preferences.layout = saved.layout;
  } catch { /* Storage can be unavailable; controls still work for this session. */ }
  const style = () => preferences.basemap === 'roads' ? `roads-${preferences.layout}` : preferences.basemap;
  const sync = () => {
    for (const b of document.querySelectorAll('[data-basemap]')) b.setAttribute('aria-pressed', String(b.dataset.basemap === preferences.basemap));
    for (const b of document.querySelectorAll('[data-layout-theme]')) b.setAttribute('aria-pressed', String(b.dataset.layoutTheme === preferences.layout));
  };
  const applyLayout = () => {
    document.documentElement.dataset.layout = preferences.layout;
    document.querySelector('meta[name=theme-color]').content = preferences.layout === 'dark' ? '#1b2937' : '#f5f6f5';
    window.dispatchEvent(new Event('display-change'));
  };
  const save = () => { try { localStorage.setItem(key, JSON.stringify(preferences)); } catch { /* Session-only preference. */ } };
  applyLayout(); sync();
  setTheme(style());
  for (const b of document.querySelectorAll('[data-basemap]')) b.addEventListener('click', () => {
    if (preferences.basemap === b.dataset.basemap) return;
    runMapUpdate('Changing basemap…', () => { preferences.basemap = b.dataset.basemap; sync(); setTheme(style()); save(); });
  });
  for (const b of document.querySelectorAll('[data-layout-theme]')) b.addEventListener('click', () => {
    if (preferences.layout === b.dataset.layoutTheme) return;
    preferences.layout = b.dataset.layoutTheme; sync(); applyLayout(); save();
    if (preferences.basemap === 'roads') runMapUpdate('Changing basemap…', () => setTheme(style()));
  });
}
