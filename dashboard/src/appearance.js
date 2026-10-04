import { setTheme } from './map.js';

// Map and data surfaces deliberately have independent preferences and palettes.
export function initAppearance() {
  const key = 'tx-appearance-v1', preferences = { map:'light', layout:'light' };
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    for (const surface of Object.keys(preferences)) if (['light','dark'].includes(saved?.[surface])) preferences[surface] = saved[surface];
  } catch { /* Storage can be unavailable; controls still work for this session. */ }
  const button = document.querySelector('#appearance-toggle');
  const menu = document.querySelector('#appearance-menu');
  const mapSelect = document.querySelector('#basemap-theme');
  const layoutSelect = document.querySelector('#layout-theme');
  const applyLayout = () => {
    document.documentElement.dataset.layout = preferences.layout;
    document.querySelector('meta[name=theme-color]').content = preferences.layout === 'dark' ? '#1b2937' : '#f5f6f5';
    window.dispatchEvent(new Event('display-change'));
  };
  mapSelect.value = preferences.map;
  layoutSelect.value = preferences.layout;
  applyLayout();
  setTheme(preferences.map);
  const save = () => { try { localStorage.setItem(key, JSON.stringify(preferences)); } catch { /* Session-only preference. */ } };
  mapSelect.addEventListener('change', () => { preferences.map = mapSelect.value; setTheme(preferences.map); save(); });
  layoutSelect.addEventListener('change', () => { preferences.layout = layoutSelect.value; applyLayout(); save(); });
  const position = () => {
    const rect = button.getBoundingClientRect();
    const gap = 6, margin = 8, width = menu.offsetWidth, height = menu.offsetHeight;
    menu.style.left = `${Math.max(margin, Math.min(rect.right - width, innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(rect.bottom + gap, innerHeight - height - margin))}px`;
  };
  menu.addEventListener('toggle', () => {
    const open = menu.matches(':popover-open');
    button.setAttribute('aria-expanded', String(open));
    if (open) position();
  });
  window.addEventListener('resize', () => { if (menu.matches(':popover-open')) position(); });
  window.addEventListener('scroll', () => { if (menu.matches(':popover-open')) position(); }, true);
}
