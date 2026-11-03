import { scaleLinear } from 'd3-scale';
import { interpolateLab } from 'd3-interpolate';
import { escapeHTML } from './data.js';

// One palette for every shaded surface. Partisan quantities (margin, Democratic share, shift, win probability toward a party)
// use a diverging scale centered on a margin of zero or 50%; everything else (turnout, counts, density, demographics) uses a
// sequential one. The choice is remembered separately for the two kinds, like the theme.
const neutral = { light:'#f2efe8', dark:'#464b54' };
// Diverging stops run from the Republican end to the Democratic end; the dark list lifts the midpoint so close races show on black.
export const partisanPresets = {
  blueRed:{ label:'Blue–Red (default)',
    light:['#9f352f', '#c86656', '#e4ab9c', neutral.light, '#b2d5dc', '#609fb5', '#1d6483'],
    dark:['#ff7a6e', '#d65a50', '#7a3a36', neutral.dark, '#2c5868', '#3a9cc0', '#5fcaf2'] },
  muted:{ label:'Blue–Red, muted',
    light:['#b3615a', '#c98a82', '#ddb8b0', neutral.light, '#bfd3d9', '#8fb0bd', '#5f8ba0'],
    dark:['#d98b82', '#aa6b64', '#6a4a47', neutral.dark, '#38535d', '#5f93a8', '#8fc0d4'] },
  cvd:{ label:'Orange–Purple (colorblind-safe)',
    light:['#b35806', '#e08214', '#fdb863', neutral.light, '#b2abd2', '#8073ac', '#542788'],
    dark:['#ffad4a', '#d9822a', '#7a4f25', neutral.dark, '#4b4280', '#8e7ad8', '#c6b6ff'] },
  purpleGreen:{ label:'Green–Purple',
    light:['#1b7837', '#5aae61', '#a6dba0', neutral.light, '#c2a5cf', '#9970ab', '#762a83'],
    dark:['#6fd18a', '#4aa862', '#2f6b43', neutral.dark, '#5a4570', '#a37fc4', '#d4b5f0'] },
  custom:{ label:'Custom colors' },
};
// Sequential stops run from low to high. The light list goes pale to dark; the dark list goes dim to bright.
export const sequentialPresets = {
  teal:{ label:'Teal (default)', light:['#edf4f2', '#c6e4df', '#90c9c3', '#55a9ac', '#2c7b8e', '#184c6a'], dark:['#415467', '#527187', '#568fa6', '#4aa8be', '#37c2d0', '#a5e4e3'] },
  blues:{ label:'Blues', light:['#eff6fc', '#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'], dark:['#20344a', '#2d5a82', '#3f84b5', '#62a8d8', '#9ccdf0', '#d8efff'] },
  reds:{ label:'Reds', light:['#fff0eb', '#fcc5b1', '#fb9a7d', '#f4694b', '#cb2f2b', '#8f0f1f'], dark:['#3a2326', '#6e2f33', '#a33b3d', '#d65a50', '#ef8a7f', '#ffc9c0'] },
  greys:{ label:'Greys', light:['#f4f4f4', '#d9d9d9', '#bdbdbd', '#969696', '#636363', '#252525'], dark:['#2a2e33', '#454b52', '#656d76', '#8a929b', '#b4bbc3', '#e8ecef'] },
  viridis:{ label:'Viridis', light:['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154'], dark:['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
  cividis:{ label:'Cividis', light:['#fee838', '#bcaf6f', '#7c7b78', '#35456c', '#00224e'], dark:['#00224e', '#35456c', '#7c7b78', '#bcaf6f', '#fee838'] },
  custom:{ label:'Custom colors' },
};
const tables = { partisan:partisanPresets, sequential:sequentialPresets };
const defaults = {
  partisan:{ preset:'blueRed', reverse:false, lo:'#b2182b', mid:'#f2efe8', hi:'#2166ac', center:'', clamp:'' },
  sequential:{ preset:'teal', reverse:false, lo:'#f4f1e8', hi:'#1b3b6f' },
};
const KEY = 'tx-palette-v1', hex = /^#[0-9a-f]{6}$/i, num = v => v === '' || (Number.isFinite(+v) && +v >= 0 && +v <= 100);
const state = { partisan:{ ...defaults.partisan }, sequential:{ ...defaults.sequential } };
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  for (const kind of Object.keys(state)) for (const [k, v] of Object.entries(saved?.[kind] || {})) {
    if (!(k in defaults[kind])) continue;
    const ok = k === 'preset' ? v in tables[kind] : k === 'reverse' ? typeof v === 'boolean' : k === 'center' || k === 'clamp' ? num(v) : hex.test(v);
    if (ok) state[kind][k] = v;
  }
} catch { /* Storage can be unavailable; choices last for this session. */ }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Session-only preference. */ } };
const themeNow = () => document.documentElement.dataset.layout === 'dark' ? 'dark' : 'light';
const changed = () => { save(); refresh(); window.dispatchEvent(new Event('palette-change')); window.dispatchEvent(new Event('display-change')); };

// Stops for one kind on one surface theme.
export function stops(kind, theme = themeNow()) {
  const s = state[kind];
  let list;
  if (s.preset === 'custom') list = kind === 'partisan' ? [s.lo, s.mid, s.hi] : theme === 'dark' ? [s.hi, s.lo] : [s.lo, s.hi];
  else list = tables[kind][s.preset][theme];
  return s.reverse ? [...list].reverse() : [...list];
}
export const chosen = kind => state[kind].preset !== defaults[kind].preset;
// Interpolates in CIELAB so a ramp passes through a clean midpoint, with t from 0 to 1 over the stops.
const cache = new Map();
export function ramp(kind, theme = themeNow()) {
  const list = stops(kind, theme), id = list.join();
  if (!cache.has(id)) { if (cache.size > 40) cache.clear(); cache.set(id, scaleLinear().domain(list.map((_, i) => i / (list.length - 1))).range(list).interpolate(interpolateLab).clamp(true)); }
  return cache.get(id);
}
export const gradient = (kind, theme = themeNow()) => { const f = ramp(kind, theme); return `linear-gradient(90deg,${Array.from({ length:9 }, (_, i) => `${f(i / 8)} ${(12.5 * i).toFixed(1)}%`).join(',')})`; };
// A value on the diverging scale: `center` is the natural center (0 for a margin or shift, .5 for a share) and `half` the distance from
// it to either end. The custom center and clamp, in points, replace them when set.
export function partisanT(v, center, half) {
  const s = state.partisan, c = center + (s.center === '' ? 0 : +s.center / 100), h = s.clamp !== '' && +s.clamp > 0 ? +s.clamp / 100 : half;
  return Math.max(0, Math.min(1, .5 + (v - c) / (2 * h)));
}
export const partisanCenter = () => state.partisan.center === '' ? 0 : +state.partisan.center / 100;
export const partisanClamp = fallbackHalf => state.partisan.clamp !== '' && +state.partisan.clamp > 0 ? +state.partisan.clamp / 100 : fallbackHalf;
// Quantities that are partisan: the model's forecast, past results, shifts and the primary-history mix of early voters.
export const isPartisan = entry => !!entry && (entry.group === 'Politics' || entry.key === 'ev_d_share');

// ---- Controls ----
const titles = { partisan:['Partisan shading', 'margin, share, shift, win probability'], sequential:['Other shading', 'turnout, counts, density, demographics'] };
const pickers = new Set();
function pickerHTML(kind) {
  const s = state[kind], custom = s.preset === 'custom', [title, about] = titles[kind];
  const opts = Object.entries(tables[kind]).map(([k, p]) => `<option value="${k}"${k === s.preset ? ' selected' : ''}>${escapeHTML(p.label)}</option>`).join('');
  const color = (name, label) => `<label>${label}<input type="color" data-field="${name}" value="${s[name]}"></label>`;
  return `<div class="pal-head"><strong>${title}</strong><span class="pal-about">${about}</span></div>
    <div class="pal-row"><label class="pal-select">Palette <select data-field="preset">${opts}</select></label><i class="pal-preview" style="background:${gradient(kind)}"></i></div>
    <label class="check pal-rev"><input type="checkbox" data-field="reverse"${s.reverse ? ' checked' : ''}> Reverse</label>
    <div class="pal-custom"${custom ? '' : ' hidden'}>
      <div class="pal-colors">${kind === 'partisan' ? `${color('lo', 'Republican end')}${color('mid', 'Midpoint')}${color('hi', 'Democratic end')}` : `${color('lo', 'Low')}${color('hi', 'High')}`}</div>
      ${kind === 'partisan' ? `<div class="pal-colors"><label>Center, points<input type="number" data-field="center" min="0" max="100" step="0.5" placeholder="0" value="${s.center}"></label><label>Clamp ±, points<input type="number" data-field="clamp" min="0" max="100" step="0.5" placeholder="auto" value="${s.clamp}"></label></div>
      <p class="pal-note">Center and clamp move the Election night map and the scatter colors. The map keeps its own center and range in Display.</p>` : ''}
    </div>`;
}
export function mountPicker(host, kind) {
  host.classList.add('pal-picker');
  const render = () => { if (host.contains(document.activeElement) && document.activeElement.matches('input[type=color],input[type=number]')) return; host.innerHTML = pickerHTML(kind); };
  host.addEventListener('input', event => {
    const el = event.target.closest('[data-field]');
    if (!el) return;
    const f = el.dataset.field, s = state[kind];
    if (el.type === 'checkbox') s[f] = el.checked;
    else if (f === 'center' || f === 'clamp') { if (!num(el.value)) return; s[f] = el.value; }
    else s[f] = el.value;
    // Colors and numbers apply as they are edited; a preset or reverse change also redraws this picker.
    if (f === 'preset' || f === 'reverse') host.innerHTML = pickerHTML(kind);
    changed();
  });
  render(); pickers.add({ host, kind, render });
  return host;
}
// The collapsible "Colors" section for the Legend panel.
export function mountColorsSection(host) {
  host.innerHTML = '<details class="pal-section"><summary>Colors</summary><div class="pal-body"><div data-pal="partisan"></div><div data-pal="sequential"></div><button type="button" class="text-button pal-reset">Reset colors</button></div></details>';
  for (const el of host.querySelectorAll('[data-pal]')) mountPicker(el, el.dataset.pal);
  host.querySelector('.pal-reset').addEventListener('click', () => { for (const k of Object.keys(state)) Object.assign(state[k], defaults[k]); for (const p of pickers) p.host.innerHTML = pickerHTML(p.kind); changed(); });
}
// A small swatch button that opens the same controls in a popover beside it. `kindOf` can be a function when the kind depends on a selection.
let pop = null;
function popover() {
  if (pop) return pop;
  pop = document.createElement('div'); pop.className = 'pal-pop'; pop.setAttribute('popover', 'auto'); pop.setAttribute('aria-label', 'Colors');
  pop.innerHTML = '<div data-pal="partisan"></div><div data-pal="sequential"></div>';
  document.body.append(pop);
  for (const el of pop.querySelectorAll('[data-pal]')) mountPicker(el, el.dataset.pal);
  return pop;
}
export function swatchButton(kind, text = '') {
  const b = document.createElement('button');
  b.type = 'button'; b.className = `pal-swatch-btn${text ? ' with-text' : ''}`; b.title = 'Change colors'; b.setAttribute('aria-label', 'Change colors'); b.dataset.palKind = kind;
  b.innerHTML = `<i></i>${text ? `<span>${escapeHTML(text)}</span>` : ''}`;
  b.addEventListener('click', () => {
    const p = popover(), first = p.querySelector(`[data-pal="${b.dataset.palKind}"]`);
    p.prepend(first);
    const r = b.getBoundingClientRect();
    p.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 300))}px`; p.style.top = `${Math.min(r.bottom + 6, innerHeight - 330)}px`;
    p.togglePopover();
  });
  refresh(b);
  return b;
}
export function refresh(only) {
  for (const b of only ? [only] : document.querySelectorAll('.pal-swatch-btn')) { const i = b.querySelector('i'); if (i) i.style.background = gradient(b.dataset.palKind === 'sequential' ? 'sequential' : 'partisan'); }
  if (!only) for (const p of pickers) { const prev = p.host.querySelector('.pal-preview'); if (prev) prev.style.background = gradient(p.kind); }
}
// CSS marks that show a lean (rank dots, early-vote dots) read these variables, which follow the partisan palette.
function syncVars() {
  const f = ramp('partisan'), root = document.documentElement.style;
  root.setProperty('--lean-r', f(.06)); root.setProperty('--lean-mid', f(.5)); root.setProperty('--lean-d', f(.94));
}
syncVars();
window.addEventListener('display-change', () => { syncVars(); refresh(); });
