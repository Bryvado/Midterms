import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { scaleLinear } from 'd3-scale';
import { base, csv, pct, count, signed, escapeHTML } from './data.js';

const bounds = [[-106.65, 25.84], [-93.51, 36.5]];
const electionColors = {
  light:['#9f352f','#c86656','#e4ab9c','#efeee8','#b2d5dc','#609fb5','#1d6483'],
  dark:['#ee766e','#d97068','#b77976','#b9c3c4','#79b5c2','#4ab0ce','#26a2d5'],
};
const volumeColors = {
  light:['#edf4f2','#c6e4df','#90c9c3','#55a9ac','#2c7b8e','#184c6a'],
  dark:['#415467','#527187','#568fa6','#4aa8be','#37c2d0','#a5e4e3'],
};
const confidenceColors = {
  light:['#f0f0f2','#dcdce9','#bcbad8','#9897c2','#7072a7','#494d88'],
  dark:['#48505f','#616a80','#7f86a7','#a3a7cf','#c5c5e7','#e4e1fa'],
};
const goldColors = {
  light:['#fbf6e4','#f1dfa0','#dcbb52','#b98d1c','#7f5d0a'],
  dark:['#4a4232','#76642f','#a8882c','#d8b23a','#f7dc7a'],
};
const neutral = { light:'#efeee8', dark:'#b9c3c4' };
const divergingPalettes = {
  redblue:{ label:'Red / blue', ...electionColors },
  orpu:{ label:'Orange / purple (colorblind-safe)',
    light:['#b35806','#e08214','#fdb863','#efeee8','#b2abd2','#8073ac','#542788'],
    dark:['#f59b2b','#d98b45','#b98f6e','#b9c3c4','#958ec2','#8f78dd','#b7a4ff'] },
  custom:{ label:'Custom colors' },
};
const sequentialPalettes = {
  teal:{ label:'Teal', ...volumeColors },
  purple:{ label:'Purple', ...confidenceColors },
  viridis:{ label:'Viridis (colorblind-safe)', light:['#fde725','#5ec962','#21918c','#3b528b','#440154'], dark:['#440154','#3b528b','#21918c','#5ec962','#fde725'] },
  magma:{ label:'Magma', light:['#fcfdbf','#fe9f6d','#de4968','#8c2981','#3b0f70'], dark:['#3b0f70','#8c2981','#de4968','#fe9f6d','#fcfdbf'] },
  custom:{ label:'Custom colors' },
};
const rangeOptions = {
  share:{ values:['.5','.3','.2','.1'], fallback:'.3', center:.5, text:r => r === .5 ? '0–100% (full)' : `${pct(.5 - r,0)}–${pct(.5 + r,0)}` },
  shift:{ values:['.05','.1','.15','.25'], fallback:'.15', center:0, text:r => `±${Math.round(100 * r)} points` },
  margin:{ values:['.1','.2','.4'], fallback:'.2', center:0, text:r => `±${Math.round(100 * r)} points` },
};
const defaults = { op:'87', ol:'30', ln:'1', oc:'0', od:'0', dpal:'redblue', spal:'teal', scale:'auto', bins:'cont', range:'', dlo:'#b2182b', dhi:'#2166ac', slo:'#f4f1e8', shi:'#1b3b6f' };
const settings = { ...defaults };
const hex = /^#[0-9a-f]{6}$/i;
const valid = {
  dpal:v => v in divergingPalettes, spal:v => v in sequentialPalettes, scale:v => ['auto','linear','log','pct'].includes(v),
  bins:v => ['cont','step'].includes(v), range:v => Object.values(rangeOptions).some(o => o.values.includes(v)),
  op:v => /^\d{1,3}$/.test(v) && +v <= 100, ol:v => /^\d{1,3}$/.test(v) && +v <= 100,
  ln:v => v === '0' || v === '1', oc:v => v === '0' || v === '1', od:v => v === '0' || v === '1',
  dlo:v => hex.test(v), dhi:v => hex.test(v), slo:v => hex.test(v), shi:v => hex.test(v),
};
const params = new URLSearchParams(location.search);
for (const key of Object.keys(defaults)) if (params.has(key) && valid[key](params.get(key))) settings[key] = params.get(key);
const message = document.querySelector('#map-message');
const tooltip = document.querySelector('#map-tooltip');
const legend = document.querySelector('#legend');
const levels = {
  county:{ tiles:'counties', details:'county_details.csv', plural:'counties' },
  precinct:{ tiles:'regions', details:'precinct_details.csv', plural:'precincts' },
  cd:{ tiles:'districts', details:'cd_details.csv', plural:'congressional districts' },
  cousub:{ tiles:'cousubs', details:'cousub_details.csv', plural:'county subdivisions' },
};
const levelKeys = Object.keys(levels);
const overlayStyle = {
  county:{ label:'County lines', light:'#8a5a19', dark:'#f0c674', width:.9, dash:[2,1.5] },
  cd:{ label:'2025 congressional district lines', light:'#141414', dark:'#ffffff', width:1.8, dash:null },
};
const outlineColor = { light:'40,60,65', dark:'240,247,247' };
let map, unit = 'county', measure = 'mean', theme = 'light', onSelect = () => {};
let measureRequest = 0;
const metricKinds = new Map();
const valueCache = new Map();

const styles = {
  light:'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark:'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const tileURL = name => `pmtiles://${new URL(`${base}${name}.pmtiles`, location.href).href}`;
const layerName = level => `${level}-fill`;
const isShift = key => key.startsWith('shift_');
const isCount = key => key === 'dem_pres24';
const sourceKey = key => key === 'result_confidence' ? 'confidence' : key === 'vote_density' ? 'net_votes_per_sqmi' : key;
const boundedValue = v => Math.min(1, Math.max(0, +v));
const compact = (v, kind) => `${kind === 'money' ? '$' : ''}${Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1 }).format(v)}`;

const levelVisible = level => level === unit || (level === 'county' && unit === 'precinct');
const fillOpacity = () => +settings.op / 100;
const outline = () => settings.ln === '1' ? `rgba(${outlineColor[theme]},${+settings.ol / 100})` : 'rgba(0,0,0,0)';

function metricType(key) {
  if (key === 'vote_density') return 'density';
  if (key === 'result_confidence') return 'confidence';
  if (key === 'p_talarico') return 'prob';
  if (key === 'margin') return 'margin';
  if (key === 'brown_share') return 'brown';
  if (isShift(key)) return 'shift';
  if (['count','money','bounded'].includes(metricKinds.get(key)) || isCount(key)) return 'seq';
  return 'share';
}
const isDiverging = type => ['density','prob','shift','share','margin'].includes(type);

function ramp(type) {
  if (isDiverging(type)) return settings.dpal === 'custom' ? [settings.dlo, neutral[theme], settings.dhi] : divergingPalettes[settings.dpal][theme];
  if (type === 'brown') return goldColors[theme];
  if (settings.spal !== 'custom') return sequentialPalettes[settings.spal][theme];
  return theme === 'dark' ? [settings.shi, settings.slo] : [settings.slo, settings.shi];
}
const colorAt = (colors, t) => scaleLinear().domain(colors.map((_, i) => i / (colors.length - 1))).range(colors).clamp(true)(t);

function format(key, v) {
  const type = metricType(key), kind = metricKinds.get(key);
  if (type === 'shift' || type === 'margin') return `${v > 0 ? '+' : v < 0 ? '−' : ''}${+Math.abs(100 * v).toFixed(1)}`;
  if (type === 'brown') return pct(v, Number.isInteger(Math.round(1000 * v) / 10) ? 0 : 1);
  if (type === 'density') return v === 0 ? '0' : `${v > 0 ? '+' : '−'}${compact(Math.abs(v))}`;
  if (type === 'seq') return kind === 'bounded' ? pct(v, 0) : compact(v, kind);
  return pct(v, v === 0 || v === 1 || Math.abs(100 * v - Math.round(100 * v)) < 1e-6 ? 0 : 1);
}

function seqMode(key) {
  if (metricType(key) !== 'seq') return 'linear';
  if (settings.scale !== 'auto') return settings.scale;
  return metricKinds.get(key) === 'count' || isCount(key) ? 'log' : 'linear';
}

// Display scale only: breakpoints for colouring, never a new estimate.
function scale(key, level = unit) {
  const type = metricType(key), colors = ramp(type), stepped = settings.bins === 'step';
  let lo, hi, center = null, edges, stops, transform = null, note = '', even = false;
  if (type === 'density') {
    edges = valueCache.get(key)[level];
    stops = edges;
    note = 'Net projected votes per square mile: Paxton ← 0 → Talarico. Color caps at the 95th percentile of absolute density.';
  } else if (type === 'prob') {
    lo = 0; hi = 1; center = .5;
    edges = [.1,.2,.3,.4,.5,.6,.7,.8,.9];
  } else if (type === 'share' || type === 'shift' || type === 'margin') {
    const opt = rangeOptions[type];
    const r = +(opt.values.includes(settings.range) ? settings.range : opt.fallback);
    center = opt.center; lo = center - r; hi = center + r;
    edges = scaleLinear().domain([lo, hi]).ticks(8).filter(v => v >= lo - 1e-9 && v <= hi + 1e-9);
    if (type === 'share') edges = edges.filter(v => v > 0 && v < 1);
    note = type === 'shift' ? 'Two-party points; grey areas lack a baseline.' : type === 'margin' ? 'Talarico minus Paxton as a share of all ballots, in points.' : lo > 0 ? `Colors saturate below ${pct(lo,0)} and above ${pct(hi,0)}.` : '';
  } else if (type === 'brown') {
    // Brown is a few percent everywhere, so the ramp spans this level's 2nd–98th percentile, rounded to half points.
    const values = valueCache.get(key)[level];
    const at = q => values[Math.floor(q * (values.length - 1))];
    lo = Math.floor(at(.02) * 200) / 200; hi = Math.max(lo + .005, Math.ceil(at(.98) * 200) / 200);
    edges = scaleLinear().domain([lo, hi]).ticks(5).filter(v => v > lo + 1e-9 && v < hi - 1e-9);
    note = `Brown votes as a share of all ballots. Colors span ${pct(lo,1)}–${pct(hi,1)}, the 2nd–98th percentile of ${levels[level].plural}.`;
  } else if (type === 'confidence') {
    lo = .5; hi = 1;
    edges = [.6,.7,.8,.9];
    note = 'Stronger color means higher confidence, regardless of candidate.';
  } else {
    const values = valueCache.get(key)[level];
    const mode = seqMode(key);
    const at = q => values[Math.floor(q * (values.length - 1))];
    if (mode === 'pct') {
      edges = [.2,.4,.6,.8].map(at);
      stops = [0,.2,.4,.6,.8,1].map(at);
      even = true;
      note = `Percentile breaks within ${levels[level].plural}.`;
    } else if (mode === 'log') {
      lo = Math.max(1, values[0]); hi = Math.max(lo * 10, values.at(-1));
      transform = 'log';
      edges = [];
      for (let p = 10 ** Math.floor(Math.log10(lo)); p <= hi; p *= 10) for (const m of [1,3]) if (p * m > lo && p * m < hi) edges.push(p * m);
      note = 'Logarithmic scale: each step is roughly three times the one before.';
    } else {
      lo = values[0]; hi = at(.98);
      if (metricKinds.get(key) === 'bounded') { lo = 0; hi = Math.max(hi, .05); }
      if (hi <= lo) hi = lo + 1;
      edges = scaleLinear().domain([lo, hi]).nice(6).ticks(6).filter(v => v > lo && v < hi);
      note = hi < values.at(-1) ? `Colors cap at ${format(key, hi)} (98th percentile); higher values share the darkest color.` : '';
    }
    if (metricKinds.get(key) === 'bounded') note += ' Estimates above 100% are capped.';
  }
  for (let i = 1; i < edges.length; i++) if (edges[i] <= edges[i-1]) edges[i] = edges[i-1] + 1e-6;
  const tx = v => transform === 'log' ? Math.log1p(Math.max(0, v)) : v;
  if (stepped) {
    const classes = edges.length + 1;
    return { stepped:true, edges, tx, transform, colors:Array.from({ length:classes }, (_, i) => colorAt(colors, i / (classes - 1))), note, lo, hi, type };
  }
  if (!stops) stops = center !== null
    ? [-1,-2/3,-1/3,0,1/3,2/3,1].map(f => center + f * (hi - lo) / 2)
    : [0,.25,.5,.75,1].map(f => transform === 'log' ? Math.expm1(tx(lo) + f * (tx(hi) - tx(lo))) : lo + f * (hi - lo));
  for (let i = 1; i < stops.length; i++) if (stops[i] <= stops[i-1]) stops[i] = stops[i-1] + 1e-6;
  const positions = even ? stops.map((_, i) => i / (stops.length - 1)) : stops.map(v => (tx(v) - tx(stops[0])) / (tx(stops.at(-1)) - tx(stops[0])));
  return { stepped:false, stops, tx, transform, positions, colors:stops.map((_, i) => colorAt(colors, type === 'density' ? i / (stops.length - 1) : positions[i])), note, lo, hi, type, even };
}

function colorExpression(key, level) {
  const s = scale(key, level);
  const column = sourceKey(key);
  const raw = ['to-number', ['get', column]];
  let value = metricKinds.get(key) === 'bounded' ? ['min', 1, ['max', 0, raw]] : raw;
  if (s.transform === 'log') value = ['ln', ['+', 1, ['max', 0, value]]];
  const paint = s.stepped
    ? ['step', value, s.colors[0], ...s.edges.flatMap((edge, i) => [s.tx(edge), s.colors[i + 1]])]
    : ['interpolate', ['linear'], value, ...s.stops.flatMap((stop, i) => [s.tx(stop), s.colors[i]])];
  return ['case', ['has', column], paint, '#afb8b8'];
}

function drawLegend() {
  let s;
  try { s = scale(measure, unit); } catch { return; }
  const select = document.querySelector('#measure');
  const title = select.selectedOptions[0]?.textContent || 'Projected share';
  const unitText = { shift:' · two-party points', share:' · Talarico two-party share', margin:' · points of all ballots', brown:' · share of all ballots', prob:'', density:'', confidence:'', seq:'' }[s.type];
  let ramp, labels;
  if (s.stepped) {
    ramp = `<div class="legend-steps">${s.colors.map(color => `<span style="background:${color}"></span>`).join('')}</div>`;
    const every = Math.ceil(s.edges.length / 7);
    labels = `<div class="legend-edges">${s.edges.map((edge, i) => (i % every) ? '' : `<span style="left:${(100 * (i + 1) / s.colors.length).toFixed(2)}%">${escapeHTML(format(measure, edge))}</span>`).join('')}</div>`;
  } else {
    const gradient = s.colors.map((color, i) => `${color} ${(100 * (s.type === 'density' ? i / (s.colors.length - 1) : s.positions[i])).toFixed(2)}%`).join(',');
    ramp = `<div class="legend-ramp" style="background:linear-gradient(90deg,${gradient})"></div>`;
    const picks = s.type === 'density' ? [0, 3, 6] : s.even ? s.stops.map((_, i) => i) : [0, Math.floor(s.stops.length / 2), s.stops.length - 1];
    labels = `<div class="legend-edges">${picks.map(i => `<span style="left:${(100 * (s.type === 'density' ? i / (s.stops.length - 1) : s.positions[i])).toFixed(2)}%">${escapeHTML(format(measure, s.stops[i]))}</span>`).join('')}</div>`;
  }
  const ends = s.type === 'prob' || s.type === 'share' || s.type === 'shift' || s.type === 'margin' || s.type === 'density' ? '<div class="legend-ends"><span>Paxton</span><span>Talarico</span></div>' : '';
  legend.innerHTML = `<div class="legend-title">${escapeHTML(title)}${escapeHTML(unitText)}${measure === 'base_pres24' || isCount(measure) ? ' · 2024 actual' : ''}</div>${ramp}${labels}${ends}<div class="legend-nodata"><span></span>No data</div>${Object.entries(overlayStyle).filter(([level]) => settings[level === 'county' ? 'oc' : 'od'] === '1').map(([, style]) => `<div class="legend-line"><span style="border-top:${Math.max(2, style.width)}px ${style.dash ? 'dashed' : 'solid'} ${style[theme]}"></span>${escapeHTML(style.label)}</div>`).join('')}${s.note ? `<div class="legend-note">${escapeHTML(s.note)}</div>` : ''}`;
  syncControls();
}

function syncControls() {
  const panel = document.querySelector('#color-panel');
  if (!panel) return;
  const type = metricType(measure), diverging = isDiverging(type);
  const palettes = diverging ? divergingPalettes : sequentialPalettes;
  const palKey = diverging ? 'dpal' : 'spal';
  const pal = panel.querySelector('#color-palette');
  pal.replaceChildren(...Object.entries(palettes).map(([k, v]) => new Option(v.label, k, false, settings[palKey] === k)));
  const custom = settings[palKey] === 'custom';
  panel.querySelector('#color-palette-row').hidden = type === 'brown';
  panel.querySelector('#color-custom').hidden = !custom || type === 'brown';
  panel.querySelector('#color-lo-label').textContent = diverging ? 'Paxton side' : 'Low';
  panel.querySelector('#color-hi-label').textContent = diverging ? 'Talarico side' : 'High';
  panel.querySelector('#color-lo').value = settings[diverging ? 'dlo' : 'slo'];
  panel.querySelector('#color-hi').value = settings[diverging ? 'dhi' : 'shi'];
  const range = panel.querySelector('#color-range');
  const opt = rangeOptions[type];
  panel.querySelector('#color-range-row').hidden = !opt;
  if (opt) range.replaceChildren(...opt.values.map(v => new Option(opt.text(+v), v, false, v === (opt.values.includes(settings.range) ? settings.range : opt.fallback))));
  panel.querySelector('#color-scale-row').hidden = type !== 'seq';
  panel.querySelector('#color-scale').value = settings.scale;
  panel.querySelector('#color-bins').value = settings.bins;
  panel.querySelector('#fill-opacity').value = settings.op;
  panel.querySelector('#fill-opacity-value').textContent = `${settings.op}%`;
  panel.querySelector('#outline-opacity').value = settings.ol;
  panel.querySelector('#outline-opacity-value').textContent = `${settings.ol}%`;
  panel.querySelector('#outline-opacity').disabled = settings.ln !== '1';
  panel.querySelector('#outline-on').checked = settings.ln === '1';
  document.querySelector('#overlay-county').checked = settings.oc === '1';
  document.querySelector('#overlay-cd').checked = settings.od === '1';
}

function applyColors() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(settings)) {
    if (value === defaults[key]) url.searchParams.delete(key); else url.searchParams.set(key, value);
  }
  history.replaceState(null, '', url);
  drawLegend();
  if (!map?.getLayer('county-fill')) return;
  for (const level of levelKeys) {
    map.setPaintProperty(layerName(level), 'fill-color', colorExpression(measure, level));
    map.setPaintProperty(layerName(level), 'fill-opacity', fillOpacity());
    map.setPaintProperty(layerName(level), 'fill-outline-color', outline());
  }
  for (const level of Object.keys(overlayStyle)) map.setLayoutProperty(`overlay-${level}`, 'visibility', settings[level === 'county' ? 'oc' : 'od'] === '1' ? 'visible' : 'none');
}

function initColorControls() {
  const panel = document.querySelector('#color-panel');
  const toggle = document.querySelector('#color-toggle');
  if (!panel || !toggle) return;
  toggle.addEventListener('click', () => {
    const owner = document.querySelector('#fp-controls').getBoundingClientRect();
    const pane = document.querySelector('.map-pane').getBoundingClientRect();
    const phone = window.matchMedia('(max-width:700px)').matches;
    panel.style.top = `${phone ? 8 : Math.max(8, owner.bottom - pane.top + 6)}px`;
    panel.style.left = `${phone ? 8 : Math.max(8, owner.left - pane.left)}px`;
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) panel.querySelector('select').focus();
  });
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); } });
  const diverging = () => isDiverging(metricType(measure));
  panel.querySelector('#color-palette').addEventListener('change', e => { settings[diverging() ? 'dpal' : 'spal'] = e.target.value; applyColors(); });
  panel.querySelector('#color-range').addEventListener('change', e => { settings.range = e.target.value; applyColors(); });
  panel.querySelector('#color-scale').addEventListener('change', e => { settings.scale = e.target.value; applyColors(); });
  panel.querySelector('#color-bins').addEventListener('change', e => { settings.bins = e.target.value; applyColors(); });
  panel.querySelector('#color-lo').addEventListener('input', e => { settings[diverging() ? 'dlo' : 'slo'] = e.target.value; applyColors(); });
  panel.querySelector('#color-hi').addEventListener('input', e => { settings[diverging() ? 'dhi' : 'shi'] = e.target.value; applyColors(); });
  panel.querySelector('#color-reset').addEventListener('click', () => { Object.assign(settings, defaults); applyColors(); });
  const sliders = { '#fill-opacity':'op', '#outline-opacity':'ol' };
  for (const [id, key] of Object.entries(sliders)) panel.querySelector(id).addEventListener('input', e => { settings[key] = String(e.target.value); applyColors(); });
  const toggles = { '#outline-on':'ln', '#overlay-county':'oc', '#overlay-cd':'od' };
  for (const [id, key] of Object.entries(toggles)) document.querySelector(id).addEventListener('change', e => { settings[key] = e.target.checked ? '1' : '0'; applyColors(); });
}

function valueText(props) {
  const v = props[sourceKey(measure)];
  const kind = metricKinds.get(measure);
  if (v === '' || v == null) return 'no data';
  if (measure === 'result_confidence') return +props.p_talarico === .5 ? `${pct(v)} · even` : `${pct(v)} · ${+props.p_talarico > .5 ? 'Talarico' : 'Paxton'} favored`;
  if (measure === 'margin') return `${signed(v)} (${+v >= 0 ? 'Talarico' : 'Paxton'} ahead)`;
  if (measure === 'brown_share') return pct(v);
  if (measure === 'vote_density') return `${+v >= 0 ? '+' : '−'}${compact(Math.abs(+v))} votes / sq mi (${+v >= 0 ? 'Talarico' : 'Paxton'} net)`;
  if (kind === 'bounded') return +v > 1 ? '100% (capped)' : pct(boundedValue(v));
  if (kind === 'money') return `$${count(v)}`;
  return kind === 'count' || isCount(measure) ? count(v) : isShift(measure) ? signed(v) : pct(v);
}

function showTooltip(event, props) {
  const label = props.region_label || props.region_id || 'Selected place';
  tooltip.innerHTML = `<strong>${escapeHTML(label)}</strong>${escapeHTML(document.querySelector('#measure').selectedOptions[0].textContent)}: ${escapeHTML(valueText(props))}<br>Projected share: ${escapeHTML(pct(props.mean))}<br>90% interval: ${escapeHTML(pct(props.q05))}–${escapeHTML(pct(props.q95))}<br><span class="note">Click for details</span>`;
  const rect = document.querySelector('.map-pane').getBoundingClientRect();
  let x = event.originalEvent.clientX - rect.left + 13;
  let y = event.originalEvent.clientY - rect.top + 13;
  x = Math.min(x, rect.width - 265);
  y = Math.min(y, rect.height - 125);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
  tooltip.hidden = false;
}

export function setUnit(next) {
  unit = next;
  document.querySelectorAll('[data-unit]').forEach(button => {
    const active = button.dataset.unit === unit;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (map?.getLayer('county-fill')) {
    for (const level of levelKeys) map.setLayoutProperty(layerName(level), 'visibility', levelVisible(level) ? 'visible' : 'none');
  }
  const note = document.querySelector('#level-note');
  if (note) {
    const controls = document.querySelector('.map-controls');
    note.style.top = `${controls.offsetTop + controls.offsetHeight + 6}px`;
    note.hidden = unit !== 'cd';
  }
  drawLegend();
  tooltip.hidden = true;
}

export async function setMeasure(next, meta) {
  const request = ++measureRequest;
  measure = next;
  if (meta) metricKinds.set(next, meta.kind);
  const type = metricType(next);
  if ((type === 'seq' || type === 'brown') && !valueCache.has(next)) {
    const tables = await Promise.all(levelKeys.map(level => csv(levels[level].details)));
    if (request !== measureRequest) return;
    const bounded = metricKinds.get(next) === 'bounded';
    const sorted = rows => {
      const values = rows.map(row => row[next]).filter(v => v !== '' && v != null).map(Number).filter(Number.isFinite).map(v => bounded ? boundedValue(v) : v).sort((a,b) => a-b);
      if (!values.length) throw new Error(`No map values for ${next}`);
      return values;
    };
    valueCache.set(next, Object.fromEntries(levelKeys.map((level, i) => [level, sorted(tables[i])])));
  }
  if (type === 'density' && !valueCache.has(next)) {
    const tables = await Promise.all(levelKeys.map(level => csv(levels[level].details)));
    if (request !== measureRequest) return;
    // Colour breaks only: 50th, 80th and 95th percentiles of absolute published density.
    const breaks = rows => {
      const abs = rows.map(row => row.net_votes_per_sqmi).filter(v => v !== '' && v != null).map(v => Math.abs(+v)).filter(Number.isFinite).sort((a,b) => a-b);
      const [b50, b80, b95] = [.5,.8,.95].map(q => abs[Math.floor(q * (abs.length - 1))]);
      return [-b95,-b80,-b50,0,b50,b80,b95];
    };
    valueCache.set(next, Object.fromEntries(levelKeys.map((level, i) => [level, breaks(tables[i])])));
  }
  if (request !== measureRequest) return;
  drawLegend();
  if (!map?.getLayer('county-fill')) return;
  for (const level of levelKeys) map.setPaintProperty(layerName(level), 'fill-color', colorExpression(measure, level));
  tooltip.hidden = true;
}

export function setTheme(next) {
  if (!styles[next] || theme === next) return;
  theme = next;
  const button = document.querySelector('#map-theme');
  button.textContent = theme === 'light' ? 'Dark map' : 'Light map';
  button.setAttribute('aria-pressed', String(theme === 'dark'));
  document.querySelector('.map-pane').dataset.theme = theme;
  drawLegend();
  if (map) map.setStyle(styles[theme]);
}

export function initMap(select) {
  onSelect = select;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  map = new maplibregl.Map({ container:'map', style:styles[theme], bounds, fitBoundsOptions: { padding: 28 }, attributionControl: false, cooperativeGestures: false });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('style.load', () => {
    // Fills and overlays go beneath the basemap's first label layer so place names stay readable.
    const labels = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
    for (const level of levelKeys) {
      map.addSource(level, { type:'vector', url:tileURL(levels[level].tiles), promoteId:'region_id' });
      map.addLayer({ id:layerName(level), type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:levelVisible(level) ? 'visible' : 'none' }, paint:{ 'fill-color':colorExpression(measure, level), 'fill-opacity':fillOpacity(), 'fill-outline-color':outline() } }, labels);
    }
    for (const [level, style] of Object.entries(overlayStyle)) {
      map.addLayer({ id:`overlay-${level}`, type:'line', source:level, 'source-layer':'regions', layout:{ visibility:settings[level === 'county' ? 'oc' : 'od'] === '1' ? 'visible' : 'none', 'line-join':'round' }, paint:{ 'line-color':style[theme], 'line-width':style.width, ...(style.dash ? { 'line-dasharray':style.dash } : {}) } }, labels);
    }
    message.hidden = true;
  });
  map.on('mousemove', e => {
    if (!map.getLayer(layerName(unit))) return;
    const features = map.queryRenderedFeatures(e.point, { layers:[layerName(unit)] });
    const feature = features[0];
    map.getCanvas().style.cursor = feature ? 'pointer' : '';
    if (feature) showTooltip(e, feature.properties);
    else tooltip.hidden = true;
  });
  map.on('mouseleave', () => { tooltip.hidden = true; });
  map.on('click', e => {
    if (!map.getLayer(layerName(unit))) return;
    const feature = map.queryRenderedFeatures(e.point, { layers:[layerName(unit)] })[0];
    if (feature) { tooltip.hidden = true; onSelect(unit, feature.properties); }
  });
  map.on('error', e => {
    const error = String(e.error?.message || e.error || '');
    if (/pmtiles|regions|counties|404|fetch/i.test(error)) {
      message.textContent = 'Map tiles could not be loaded. The other data remains available.';
      message.hidden = false;
    }
    console.error('Map error:', e.error);
  });
  document.querySelector('#reset-map').addEventListener('click', () => map.fitBounds(bounds, { padding: 28, duration: 450 }));
  document.querySelector('#map-theme').addEventListener('click', () => setTheme(theme === 'light' ? 'dark' : 'light'));
  initColorControls();
  drawLegend();
  return map;
}
