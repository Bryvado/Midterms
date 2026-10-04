import { applyMapLabels } from './map-labels.js';
import { classify, classificationMethods } from './classification.js';
import { darkMapColor } from './map-colors.js';
import { setMapProgress, configureMapLoading, runMapUpdate, isMapBusy, failMapUpdate } from './map-loading.js';
import { placeMeasures } from './metrics.js';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { scaleLinear } from 'd3-scale';
import { interpolateLab } from 'd3-interpolate';
import { base, csv, pct, count, signed, escapeHTML } from './data.js';

const bounds = [[-106.65, 25.84], [-93.51, 36.5]];
const neutral = { light:'#f2efe8', dark:'#464b54' };
const electionColors = {
  light:['#9f352f','#c86656','#e4ab9c','#f2efe8','#b2d5dc','#609fb5','#1d6483'],
  // Lift the dark neutral midpoint so close races stay visible against the black basemap.
  dark:['#ff7a6e','#d65a50','#7a3a36',neutral.dark,'#2c5868','#3a9cc0','#5fcaf2'],
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
const divergingPalettes = {
  redblue:{ label:'Red / blue', ...electionColors },
  orpu:{ label:'Orange / purple (colorblind-safe)',
    light:['#b35806','#e08214','#fdb863','#f2efe8','#b2abd2','#8073ac','#542788'],
    dark:['#ffad4a','#d9822a','#7a4f25',neutral.dark,'#4b4280','#8e7ad8','#c6b6ff'] },
  custom:{ label:'Custom colors' },
};
const sequentialPalettes = {
  teal:{ label:'Teal', ...volumeColors },
  purple:{ label:'Purple', ...confidenceColors },
  gold:{ label:'Gold', ...goldColors },
  viridis:{ label:'Viridis (colorblind-safe)', light:['#fde725','#5ec962','#21918c','#3b528b','#440154'], dark:['#440154','#3b528b','#21918c','#5ec962','#fde725'] },
  magma:{ label:'Magma', light:['#fcfdbf','#fe9f6d','#de4968','#8c2981','#3b0f70'], dark:['#3b0f70','#8c2981','#de4968','#fe9f6d','#fcfdbf'] },
  custom:{ label:'Custom colors' },
};
// Basemap background colours; the map pane uses the same colour so unpainted canvas pixels never show as a block.
const basemapBackground = { light:'rgb(242,243,240)', dark:'rgb(12,12,12)' };
const ratings = {
  margin:{ edges:[-.2,-.1,-.05,-.02,.02,.05,.1,.2], labels:['Safe Paxton (20+)','Likely Paxton (10–20)','Lean Paxton (5–10)','Tilt Paxton (2–5)','Tossup (under 2)','Tilt Talarico (2–5)','Lean Talarico (5–10)','Likely Talarico (10–20)','Safe Talarico (20+)'] },
  prob:{ edges:[.05,.2,.35,.45,.55,.65,.8,.95], labels:['Safe Paxton (Talarico <5%)','Likely Paxton (5–20%)','Lean Paxton (20–35%)','Tilt Paxton (35–45%)','Tossup (45–55%)','Tilt Talarico (55–65%)','Lean Talarico (65–80%)','Likely Talarico (80–95%)','Safe Talarico (≥95%)'] },
};

// Global display settings: palette, custom colours, opacity and boundary lines.
const defaults = { bw:'0.7', op:'87', ol:'30', ln:'1', oc:'0', od:'0', dpal:'redblue', spal:'teal', dlo:'#b2182b', dhi:'#2166ac', slo:'#f4f1e8', shi:'#1b3b6f' };
const settings = { ...defaults };
const hex = /^#[0-9a-f]{6}$/i;
const valid = {
  bw:v => Number.isFinite(+v) && +v >= 0 && +v <= 5,
  dpal:v => v in divergingPalettes, spal:v => v in sequentialPalettes,
  op:v => /^\d{1,3}$/.test(v) && +v <= 100, ol:v => /^\d{1,3}$/.test(v) && +v <= 100,
  ln:v => v === '0' || v === '1', oc:v => v === '0' || v === '1', od:v => v === '0' || v === '1',
  dlo:v => hex.test(v), dhi:v => hex.test(v), slo:v => hex.test(v), shi:v => hex.test(v),
};
const params = new URLSearchParams(location.search);
for (const key of Object.keys(defaults)) if (params.has(key) && valid[key](params.get(key))) settings[key] = params.get(key);

// Per-metric scale choices (center, range, custom bounds, bins, log), remembered across metric switches.
const scaleState = new Map();
const parseScales = text => {
  for (const entry of (text || '').split(';')) {
    const split = entry.indexOf(':');
    const key = entry.slice(0, split), rest = entry.slice(split + 1);
    if (!key || !rest || !/^[\w]+$/.test(key)) continue;
    const s = {};
    for (const pair of rest.split(',')) { const [k, v] = pair.split('='); if (['c','r','lo','hi','b','log','k'].includes(k) && v != null && /^[-\w.:]+$/.test(v)) s[k] = v; }
    scaleState.set(key, s);
  }
};
parseScales(params.get('sc'));

const message = document.querySelector('#map-message');
const tooltip = document.querySelector('#map-tooltip');
const legend = document.querySelector('#legend');
const pane = document.querySelector('.map-pane');
const levels = {
  county:{ tiles:'counties', details:'county_details.csv', projections:'county_projections.csv', plural:'counties' },
  precinct:{ tiles:'regions', details:'precinct_details.csv', projections:'regional_projections.csv', plural:'precincts' },
  cd:{ tiles:'districts', details:'cd_details.csv', projections:'cd_projections.csv', plural:'congressional districts' },
  cousub:{ tiles:'cousubs', details:'cousub_details.csv', projections:'cousub_projections.csv', plural:'county subdivisions' },
};
const levelKeys = Object.keys(levels);
const overlayStyle = {
  county:{ label:'County lines', light:'#d29b1f', dark:'#f0c674', width:1.2, dash:[2,1.5] },
  cd:{ label:'2025 congressional district lines', light:'#141414', dark:'#ffffff', width:1.8, dash:null },
};
const outlineColor = { light:'40,60,65', dark:'240,247,247' };
let map, unit = levels[params.get('u')] ? params.get('u') : 'county', measure = 'mean', theme = 'light', onSelect = () => {};
const levelSettings = new Map();
let savedDisplay;
try { savedDisplay = JSON.parse(params.get('ds') || localStorage.getItem('midterms-display-levels-v1') || '{}'); } catch { savedDisplay = {}; }
for (const level of levelKeys) {
  const saved = savedDisplay.levels?.[level] || {};
  const clean = { ...defaults };
  for (const key of Object.keys(defaults)) if (saved[key] != null && valid[key](String(saved[key]))) clean[key] = String(saved[key]);
  levelSettings.set(level, clean);
}
if (!params.has('sc')) for (const [key, value] of Object.entries(savedDisplay.scales || {})) {
  if (/^(county|precinct|cd|cousub)__\w+$/.test(key) && value && typeof value === 'object') scaleState.set(key, value);
}
const scaleKey = key => `${unit}__${key}`;
for (const [key, value] of [...scaleState]) if (!key.includes('__')) { scaleState.set(scaleKey(key), value); scaleState.delete(key); }
for (const key of Object.keys(defaults)) if (params.has(key) && valid[key](params.get(key))) levelSettings.get(unit)[key] = params.get(key);
Object.assign(settings, levelSettings.get(unit));
function saveDisplay() {
  levelSettings.set(unit, { ...settings });
  try { localStorage.setItem('midterms-display-levels-v1', JSON.stringify({levels:Object.fromEntries(levelSettings),scales:Object.fromEntries(scaleState)})); } catch {}
}
let measureRequest = 0;
let reference = { stateShare:null, baselines:[] };
let viewRange = null;
const metricKinds = new Map(placeMeasures.map(metric => [metric.key, metric.kind]));
export const currentUnit = () => unit;
const stateValues = new Map();

const styles = {
  // OpenFreeMap styles, no API key. Positron is on the quick-start guide; Dark is listed in the openfreemap-styles README.
  light:'https://tiles.openfreemap.org/styles/positron',
  dark:'https://tiles.openfreemap.org/styles/dark',
};
const tileURL = name => `pmtiles://${new URL(`${base}${name}.pmtiles`, location.href).href}`;
const layerName = level => `${level}-fill`;
const isShift = key => key.startsWith('shift_');
const isCount = key => key === 'dem_pres24';
const sourceKey = key => key === 'result_confidence' ? 'confidence' : key === 'vote_density' ? 'net_votes_per_sqmi' : key;
const boundedValue = v => Math.min(1, Math.max(0, +v));
const compact = (v, kind) => `${kind === 'money' ? '$' : ''}${Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1 }).format(v)}`;
// Only the active unit's fill draws; county and district outlines are available as line overlays.
const levelVisible = level => level === unit;
const fillOpacity = () => +settings.op / 100;
const outline = () => settings.ln === '1' ? `rgba(${outlineColor[theme]},${+settings.ol / 100})` : 'rgba(0,0,0,0)';
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

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
// Percent-like metrics take custom bounds in percent or points; counts and density take raw numbers.
const percentUnits = key => ['share','prob','brown','confidence','margin','shift'].includes(metricType(key)) || metricKinds.get(key) === 'bounded';

// What each metric type offers, and its defaults.
function options(key) {
  const type = metricType(key);
  const centers = [];
  if (type === 'share') {
    centers.push(['even','50% (even)']);
    if (Number.isFinite(reference.stateShare)) centers.push(['state',`Statewide forecast (${pct(reference.stateShare)})`]);
    for (const b of reference.baselines) centers.push([`base:${b.baseline}`,`${b.short} statewide result (${pct(b.baseline_2p)})`]);
  } else if (type === 'shift') {
    centers.push(['zero','0 (no shift)']);
    const b = reference.baselines.find(row => `shift_${row.baseline}` === key);
    if (b) centers.push(['state',`Statewide shift (${signed(b.shift_mean)})`]);
  } else if (type === 'margin' || type === 'density') centers.push(['zero','0']);
  else if (type === 'prob') centers.push(['even','50% (even)']);
  const fits = [['view','Fit to view (5th–95th pct.)'],['state','Fit to state (5th–95th pct.)']];
  const preset = r => [`p${r}`, type === 'share' ? `±${Math.round(100 * r)} pts around center` : `±${Math.round(100 * r)} pts`];
  let ranges, range;
  if (type === 'share') { ranges = [...fits,['comp','Competitive focus (±5 pts)'],...[.5,.3,.2,.1].map(preset),['custom','Custom']]; range = 'p0.3'; }
  else if (type === 'margin') { ranges = [...fits,['comp','Competitive focus (±5 pts)'],...[.1,.2,.4].map(preset),['custom','Custom']]; range = 'p0.2'; }
  else if (type === 'shift') { ranges = [...fits,['comp','Competitive focus (±3 pts)'],...[.05,.1,.15,.25].map(preset),['custom','Custom']]; range = 'p0.15'; }
  else if (type === 'prob') { ranges = [['full','0–100%']]; range = 'full'; }
  else if (type === 'confidence') { ranges = [['full','50–100%'],...fits,['custom','Custom']]; range = 'full'; }
  else { ranges = [...fits,['custom','Custom']]; range = 'state'; }
  const bins = [['cont','Continuous'],['step','Round-number steps'],...Object.entries(classificationMethods)];
  if (type === 'margin' || type === 'prob') bins.push(['rat','Ratings categories']);
  const log = type === 'seq' && ['count','money'].includes(metricKinds.get(key) || (isCount(key) ? 'count' : ''));
  return { type, centers, ranges, bins, log, defaults:{ c:centers[0]?.[0] || '', r:range, b:'cont', k:'6', log:log && (metricKinds.get(key) === 'count' || isCount(key)) ? '1' : '0' } };
}

function current(key = measure) {
  const opt = options(key);
  const s = { ...opt.defaults, ...(scaleState.get(scaleKey(key)) || {}) };
  if (!opt.centers.some(([v]) => v === s.c)) s.c = opt.defaults.c;
  if (!opt.ranges.some(([v]) => v === s.r)) s.r = opt.defaults.r;
  if (!opt.bins.some(([v]) => v === s.b)) s.b = opt.defaults.b;
  s.k = /^[3-9]$/.test(String(s.k)) ? String(s.k) : '6';
  if (!opt.log) s.log = '0';
  return { opt, s };
}

function centerValue(key, c) {
  const type = metricType(key);
  if (c === 'state' && type === 'share') return reference.stateShare;
  if (c === 'state' && type === 'shift') return +reference.baselines.find(row => `shift_${row.baseline}` === key)?.shift_mean || 0;
  if (c?.startsWith('base:')) return +reference.baselines.find(row => row.baseline === c.slice(5))?.baseline_2p;
  return type === 'share' || type === 'prob' ? .5 : 0;
}

function centerText(key, c) {
  return options(key).centers.find(([v]) => v === c)?.[1] || '';
}

function ramp(type, surfaceTheme = theme) {
  if (isDiverging(type)) return settings.dpal === 'custom' ? [settings.dlo, neutral[surfaceTheme], settings.dhi] : divergingPalettes[settings.dpal][surfaceTheme];
  if (settings.spal === 'custom') return surfaceTheme === 'dark' ? [settings.shi, settings.slo] : [settings.slo, settings.shi];
  if (type === 'brown' && settings.spal === defaults.spal) return goldColors[surfaceTheme];
  return sequentialPalettes[settings.spal][surfaceTheme];
}
// Interpolate in CIELAB so the ramp passes through a clean light midpoint instead of a muddy RGB mix.
const colorAt = (colors, t) => scaleLinear().domain(colors.map((_, i) => i / (colors.length - 1))).range(colors).interpolate(interpolateLab).clamp(true)(t);
const mapColorAt = (colors, t, type) => {
  const color = colorAt(colors, t);
  return theme === 'dark' ? darkMapColor(color, t, isDiverging(type)) : color;
};
// Shared with the poll chart: a margin in points on the requested surface’s diverging palette, clamped at ±8, neutral at 0.
export function marginColor(points, surfaceTheme = theme) {
  const colors = [...ramp('margin', surfaceTheme)];
  // Polls keep their own lighter neutral, independent of the map midpoint.
  if (surfaceTheme === 'dark') colors[Math.floor(colors.length / 2)] = '#becbd5';
  return colorAt(colors, .5 + Math.max(-8, Math.min(8, points)) / 16);
}
export const partyColor = (side, surfaceTheme = theme) => colorAt(ramp('margin', surfaceTheme), side === 'D' ? 1 : 0);
const announce = () => window.dispatchEvent(new Event('display-change'));

function format(key, v) {
  const type = metricType(key), kind = metricKinds.get(key);
  const p1 = x => `${+(100 * x).toFixed(Math.abs(100 * x - Math.round(100 * x)) < .05 ? 0 : 1)}`;
  if (type === 'shift' || type === 'margin') return `${v > 0 ? '+' : v < 0 ? '−' : ''}${p1(Math.abs(v))} pts`;
  if (type === 'density') return v === 0 ? '0' : `${v > 0 ? '+' : '−'}${compact(Math.abs(v))}`;
  if (type === 'seq' && kind !== 'bounded') return compact(v, kind);
  return `${p1(v)}%`;
}

async function loadStateValues(key, level) {
  const id = `${key}|${level}`;
  if (stateValues.has(id)) return stateValues.get(id);
  const column = sourceKey(key);
  const [details, projections] = await Promise.all([csv(levels[level].details), csv(levels[level].projections)]);
  const rows = details.columns.includes(column) ? details : projections;
  const bounded = metricKinds.get(key) === 'bounded';
  const values = rows.map(row => row[column]).filter(v => v !== '' && v != null && v !== 'NA').map(Number).filter(Number.isFinite).map(v => bounded ? boundedValue(v) : v).sort((a,b) => a-b);
  if (!values.length) throw new Error(`No map values for ${key}`);
  stateValues.set(id, values);
  return values;
}

function viewValues() {
  if (!map?.getLayer(layerName(unit))) return [];
  const column = sourceKey(measure), seen = new Set(), values = [];
  const bounded = metricKinds.get(measure) === 'bounded';
  for (const f of map.queryRenderedFeatures({ layers:[layerName(unit)] })) {
    const id = f.properties.region_id;
    if (seen.has(id)) continue;
    seen.add(id);
    const v = f.properties[column];
    if (v !== '' && v != null && Number.isFinite(+v)) values.push(bounded ? boundedValue(v) : +v);
  }
  return values.sort((a,b) => a-b);
}

// Display scale only: the domain and breakpoints decide colours; nothing here is presented as data.
function scale(key, level = unit) {
  const { opt, s } = current(key);
  const type = opt.type, diverging = isDiverging(type), colors = ramp(type);
  const log = s.log === '1';
  const levelName = levels[level].plural;
  let lo, hi, center = diverging ? centerValue(key, s.c) : null, rangeNote = '';
  if (s.b in classificationMethods) {
    const values = stateValues.get(`${key}|${level}`) || [];
    if (values.length) {
      lo = values[0]; hi = values.at(-1);
      let edges = classify(values, s.b, +s.k);
      if (diverging && center > lo && center < hi) edges = [...new Set([...edges, center])].sort((a,b)=>a-b);
      const limits = [lo,...edges,hi];
      const position = v => diverging ? (v <= center ? .5-.5*(center-v)/Math.max(1e-9,center-lo) : .5+.5*(v-center)/Math.max(1e-9,hi-center)) : (v-lo)/Math.max(1e-9,hi-lo);
      const classColors = limits.slice(0,-1).map((v,i)=>mapColorAt(colors,position((v+limits[i+1])/2),type));
      return {kind:'step',type,edges,colors:classColors,lo,hi,note:`${classificationMethods[s.b]}; ${classColors.length} classes across all ${levelName}, one observation per area. Breaks use raw values. ${diverging ? 'The selected center is retained as a boundary; this can add a class. ' : ''}Tied values stay together. These are display classes, not confidence categories.`};
    }
  }
  if (s.b === 'rat') {
    const r = ratings[type];
    return { kind:'ratings', type, edges:r.edges, labels:r.labels, colors:r.labels.map((_, i) => mapColorAt(colors, i / (r.labels.length - 1), type)),
      note:type === 'margin' ? 'Talarico minus Paxton as a share of all ballots, in points.' : 'Modeled chance that Talarico leads.' };
  }
  const fit = values => {
    if (!values?.length) return null;
    const p5 = quantile(values, .05), p95 = quantile(values, .95);
    if (diverging) { const r = Math.max(Math.abs(p5 - center), Math.abs(p95 - center), 1e-4); return [center - r, center + r]; }
    return [log ? Math.max(1, p5) : p5, p95 > p5 ? p95 : p5 + (log ? 10 : 1e-3)];
  };
  if (s.r === 'view') {
    const got = viewRange && viewRange.key === key && viewRange.level === level ? viewRange.domain : null;
    [lo, hi] = got || fit(stateValues.get(`${key}|${level}`)) || [0, 1];
    rangeNote = got ? `fit to the 5th–95th percentile of ${levelName} in view` : `fit to the 5th–95th percentile of all ${levelName} until the map settles`;
  } else if (s.r === 'state') {
    [lo, hi] = fit(stateValues.get(`${key}|${level}`)) || [0, 1];
    rangeNote = `fit to the 5th–95th percentile of all ${levelName}`;
  } else if (s.r === 'comp') {
    const r = type === 'shift' ? .03 : .05; lo = center - r; hi = center + r; rangeNote = 'competitive focus';
  } else if (s.r?.startsWith('p')) {
    const r = +s.r.slice(1); lo = center - r; hi = center + r;
  } else if (s.r === 'full') {
    [lo, hi] = type === 'confidence' ? [.5, 1] : [0, 1];
  } else {
    const k = percentUnits(key) ? 100 : 1;
    lo = Number.isFinite(+s.lo) && s.lo !== '' ? +s.lo / k : 0; hi = Number.isFinite(+s.hi) && s.hi !== '' ? +s.hi / k : 1;
    if (hi <= lo) hi = lo + (k === 100 ? .01 : 1);
    if (diverging) center = Math.min(hi, Math.max(lo, center));
    rangeNote = 'custom bounds';
  }
  if (log) lo = Math.max(1, lo);
  const tx = v => log ? Math.log1p(Math.max(0, v)) : v;
  const tPos = v => diverging
    ? (v <= center ? .5 - .5 * (center - v) / Math.max(1e-9, center - lo) : .5 + .5 * (v - center) / Math.max(1e-9, hi - center))
    : (tx(v) - tx(lo)) / Math.max(1e-9, tx(hi) - tx(lo));
  const units = { share:'Talarico two-party share', margin:'Talarico minus Paxton, points of all ballots', shift:'two-party points', prob:'chance Talarico leads', confidence:'larger candidate’s chance of leading', brown:'Brown share of all ballots', density:'net Talarico minus Paxton votes per square mile' }[type] || '';
  const centerNote = diverging && options(key).centers.length > 1 && !['even','zero'].includes(s.c) ? ` Centered on the ${centerText(key, s.c).replace(/^Statewide/, 'statewide')}.` : '';
  const note = `${units ? `${units[0].toUpperCase()}${units.slice(1)}.` : ''}${centerNote} Colors span ${format(key, lo)} to ${format(key, hi)}${rangeNote ? ` (${rangeNote})` : ''} and saturate beyond.${type === 'shift' ? ' Grey areas lack a baseline.' : ''}${metricKinds.get(key) === 'bounded' ? ' Estimates above 100% are capped.' : ''}`;
  if (s.b === 'step') {
    let edges;
    if (diverging) {
      const step = scaleLinear().domain([lo, hi]).ticks(8);
      const size = step.length > 1 ? step[1] - step[0] : (hi - lo) / 8;
      edges = [];
      for (let v = center - size; v > lo + 1e-9; v -= size) edges.unshift(v);
      edges.push(center);
      for (let v = center + size; v < hi - 1e-9; v += size) edges.push(v);
    } else if (log) {
      edges = [];
      for (let p = 10 ** Math.floor(Math.log10(lo)); p <= hi; p *= 10) for (const m of [1,3]) if (p * m > lo && p * m < hi) edges.push(p * m);
    } else edges = scaleLinear().domain([lo, hi]).ticks(6).filter(v => v > lo + 1e-9 && v < hi - 1e-9);
    if (!edges.length) edges = [(lo + hi) / 2];
    // Each class takes the colour at its midpoint; the open-ended outer classes use the midpoint to the range end.
    const limits = [lo, ...edges, hi];
    const classColors = limits.slice(0, -1).map((start, i) => mapColorAt(colors, tPos((start + limits[i + 1]) / 2), type));
    return { kind:'step', type, edges, tx, log, colors:classColors, lo, hi, note };
  }
  const stops = diverging
    ? [lo, center - (center - lo) * 2 / 3, center - (center - lo) / 3, center, center + (hi - center) / 3, center + (hi - center) * 2 / 3, hi]
    : [0,.25,.5,.75,1].map(f => log ? Math.expm1(tx(lo) + f * (tx(hi) - tx(lo))) : lo + f * (hi - lo));
  for (let i = 1; i < stops.length; i++) if (stops[i] <= stops[i-1]) stops[i] = stops[i-1] + 1e-9;
  const positions = stops.map(v => (tx(v) - tx(stops[0])) / Math.max(1e-9, tx(stops.at(-1)) - tx(stops[0])));
  return { kind:'cont', type, stops, tx, log, positions, colors:stops.map(v => mapColorAt(colors, tPos(v), type)), lo, hi, center, note };
}

function colorExpression(key, level) {
  const s = scale(key, level);
  const column = sourceKey(key);
  const raw = ['to-number', ['get', column]];
  let value = metricKinds.get(key) === 'bounded' ? ['min', 1, ['max', 0, raw]] : raw;
  const tx = s.tx || (v => v);
  if (s.log) value = ['ln', ['+', 1, ['max', 0, value]]];
  const paint = s.kind === 'cont'
    ? ['interpolate', ['linear'], value, ...s.stops.flatMap((stop, i) => [tx(stop), s.colors[i]])]
    : ['step', value, s.colors[0], ...s.edges.flatMap((edge, i) => [tx(edge), s.colors[i + 1]])];
  return ['case', ['has', column], paint, '#afb8b8'];
}

function legendTitle() {
  const label = document.querySelector('#measure').selectedOptions[0]?.textContent || 'Projected share';
  const qualifier = measure === 'base_pres24' || isCount(measure) ? '2024 actual' : '';
  return qualifier ? `${label} · ${qualifier}` : label;
}

function drawLegend() {
  let s;
  try { s = scale(measure, unit); } catch { return; }
  let body;
  if (s.kind === 'ratings') {
    body = `<ul class="legend-cats">${s.labels.map((label, i) => `<li><span style="background:${s.colors[i]}"></span>${escapeHTML(label)}</li>`).join('')}</ul>`;
  } else if (s.kind === 'step') {
    const every = Math.ceil(s.edges.length / 6);
    body = `<div class="legend-steps">${s.colors.map(color => `<span style="background:${color}"></span>`).join('')}</div>
      <div class="legend-edges">${s.edges.map((edge, i) => (i % every) ? '' : `<span style="left:${(100 * (i + 1) / s.colors.length).toFixed(2)}%">${escapeHTML(format(measure, edge))}</span>`).join('')}</div>`;
  } else {
    const gradient = s.colors.map((color, i) => `${color} ${(100 * s.positions[i]).toFixed(2)}%`).join(',');
    const picks = isDiverging(s.type) ? [0, 3, 6] : [0, 2, 4];
    body = `<div class="legend-ramp" style="background:linear-gradient(90deg,${gradient})"></div>
      <div class="legend-edges">${picks.map(i => `<span style="left:${(100 * s.positions[i]).toFixed(2)}%">${escapeHTML(format(measure, s.stops[i]))}</span>`).join('')}</div>`;
  }
  const ends = isDiverging(s.type) && s.kind !== 'ratings' ? '<div class="legend-ends"><span>Paxton</span><span>Talarico</span></div>' : '';
  const lines = Object.entries(overlayStyle).filter(([level]) => settings[level === 'county' ? 'oc' : 'od'] === '1').map(([, style]) => `<div class="legend-line"><span style="border-top:${Math.max(2, style.width)}px ${style.dash ? 'dashed' : 'solid'} ${style[theme]}"></span>${escapeHTML(style.label)}</div>`).join('');
  legend.innerHTML = `<div class="legend-title">${escapeHTML(legendTitle())}</div>${body}${ends}<div class="legend-nodata"><span></span>No data</div>${lines}${s.note ? `<div class="legend-note">${escapeHTML(s.note)}</div>` : ''}`;
  syncControls();
}

function writeURL() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(settings)) {
    if (value === defaults[key]) url.searchParams.delete(key); else url.searchParams.set(key, value);
  }
  for (const old of ['scale','bins','range']) url.searchParams.delete(old);
  const entries = [...scaleState].map(([key, s]) => {
    const d = options(key.split('__').at(-1)).defaults;
    const pairs = Object.entries(s).filter(([k, v]) => v !== '' && v != null && v !== d[k]).map(([k, v]) => `${k}=${v}`);
    return pairs.length ? `${key}:${pairs.join(',')}` : '';
  }).filter(Boolean);
  if (entries.length) url.searchParams.set('sc', entries.join(';')); else url.searchParams.delete('sc');
  if (measure !== 'mean') url.searchParams.set('m', measure); else url.searchParams.delete('m');
  if (unit !== 'county') url.searchParams.set('u', unit); else url.searchParams.delete('u');
  url.searchParams.set('ds', JSON.stringify({levels:Object.fromEntries(levelSettings)}));
  history.replaceState(null, '', url);
}

function setOptions(select, list, value) {
  select.replaceChildren(...list.map(([v, text]) => new Option(text, v, false, v === value)));
}

function syncControls() {
  const panel = document.querySelector('#display-panel');
  if (!panel) return;
  const { opt, s } = current();
  const diverging = isDiverging(opt.type);
  const palettes = diverging ? divergingPalettes : sequentialPalettes;
  const palKey = diverging ? 'dpal' : 'spal';
  setOptions(panel.querySelector('#color-palette'), Object.entries(palettes).map(([k, v]) => [k, v.label]), settings[palKey]);
  panel.querySelector('#color-palette-note').textContent = opt.type === 'brown' && settings.spal === defaults.spal ? 'Brown share uses gold unless another palette is chosen.' : '';
  panel.querySelector('#color-custom').hidden = settings[palKey] !== 'custom';
  panel.querySelector('#color-lo-label').textContent = diverging ? 'Paxton side' : 'Low';
  panel.querySelector('#color-hi-label').textContent = diverging ? 'Talarico side' : 'High';
  panel.querySelector('#color-lo').value = settings[diverging ? 'dlo' : 'slo'];
  panel.querySelector('#color-hi').value = settings[diverging ? 'dhi' : 'shi'];
  panel.querySelector('#scale-center-row').hidden = opt.centers.length < 2;
  setOptions(panel.querySelector('#scale-center'), opt.centers, s.c);
  setOptions(panel.querySelector('#scale-range'), opt.ranges, s.r);
  panel.querySelector('#scale-range').disabled = opt.ranges.length < 2 || (s.b === 'rat' || s.b in classificationMethods);
  const custom = s.r === 'custom' && s.b !== 'rat' && !(s.b in classificationMethods);
  panel.querySelector('#scale-custom').hidden = !custom;
  if (custom) {
    const units = percentUnits(measure) ? (['margin','shift'].includes(opt.type) ? 'pts' : '%') : '';
    panel.querySelector('#scale-custom-units').textContent = units ? `in ${units === 'pts' ? 'points' : 'percent'}` : '';
    const k = percentUnits(measure) ? 100 : 1, sc = scale(measure);
    const lo = panel.querySelector('#scale-min'), hi = panel.querySelector('#scale-max');
    if (document.activeElement !== lo) lo.value = s.lo !== undefined && s.lo !== '' ? s.lo : +(sc.lo * k).toFixed(2);
    if (document.activeElement !== hi) hi.value = s.hi !== undefined && s.hi !== '' ? s.hi : +(sc.hi * k).toFixed(2);
  }
  setOptions(panel.querySelector('#scale-bins'), opt.bins, s.b);
  panel.querySelector('#scale-classes-row').hidden = !(s.b in classificationMethods);
  panel.querySelector('#scale-classes').value = s.k;
  panel.querySelector('#scale-log-row').hidden = !opt.log || s.b in classificationMethods;
  panel.querySelector('#outline-width').value = settings.bw;
  panel.querySelector('#outline-width-value').textContent = `${settings.bw}px`;
  panel.querySelector('#outline-width').disabled = settings.ln !== '1';
  panel.querySelector('#scale-log').checked = s.log === '1';
  panel.querySelector('#fill-opacity').value = settings.op;
  panel.querySelector('#fill-opacity-value').textContent = `${settings.op}%`;
  panel.querySelector('#outline-opacity').value = settings.ol;
  panel.querySelector('#outline-opacity-value').textContent = `${settings.ol}%`;
  panel.querySelector('#outline-opacity').disabled = settings.ln !== '1';
  panel.querySelector('#outline-on').checked = settings.ln === '1';
  panel.querySelector('#overlay-county').checked = settings.oc === '1';
  panel.querySelector('#overlay-cd').checked = settings.od === '1';
}

async function ensureValues() {
  const { s } = current();
  if ((['view','state'].includes(s.r) && s.b !== 'rat') || s.b in classificationMethods) await loadStateValues(measure, unit);
}

function paint() {
  saveDisplay();
  announce();
  writeURL();
  drawLegend();
  if (!map?.getLayer('county-fill')) return;
  for (const level of levelKeys) {
    map.setPaintProperty(layerName(level), 'fill-color', colorExpression(measure, level));
    map.setPaintProperty(layerName(level), 'fill-opacity', fillOpacity());
    map.setPaintProperty(`border-${level}`, 'line-color', outline());
    map.setPaintProperty(`border-${level}`, 'line-width', +settings.bw);
    map.setLayoutProperty(`border-${level}`, 'visibility', levelVisible(level) ? 'visible' : 'none');
  }
  for (const level of Object.keys(overlayStyle)) map.setLayoutProperty(`overlay-${level}`, 'visibility', settings[level === 'county' ? 'oc' : 'od'] === '1' ? 'visible' : 'none');
}

async function applyDisplay(signal) {
  await ensureValues();
  signal?.throwIfAborted();
  paint();
  scheduleFit();
}

// Fit to view: recompute the 5th–95th percentile of rendered areas once the map stops moving.
function refitView() {
  const { opt, s } = current();
  if (s.r !== 'view' || s.b === 'rat' || s.b in classificationMethods || !map) return;
  const values = viewValues();
  if (values.length < 3) return;
  const center = isDiverging(opt.type) ? centerValue(measure, s.c) : null;
  const p5 = quantile(values, .05), p95 = quantile(values, .95);
  let domain;
  if (center !== null) { const r = Math.max(Math.abs(p5 - center), Math.abs(p95 - center), 1e-4); domain = [center - r, center + r]; }
  else domain = [s.log === '1' ? Math.max(1, p5) : p5, p95 > p5 ? p95 : p5 + 1e-3];
  const prev = viewRange?.key === measure && viewRange.level === unit ? viewRange.domain : null;
  if (prev && Math.abs(prev[0] - domain[0]) < 1e-9 && Math.abs(prev[1] - domain[1]) < 1e-9) return;
  viewRange = { key:measure, level:unit, domain };
  drawLegend();
  map.setPaintProperty(layerName(unit), 'fill-color', colorExpression(measure, unit));
}
function scheduleFit() { if (map) map.once('idle', refitView); }

function updateScale(patch, signal) {
  const prev = scaleState.get(scaleKey(measure)) || {};
  scaleState.set(scaleKey(measure), { ...prev, ...patch });
  viewRange = null;
  return applyDisplay(signal);
}

function initDisplayControls() {
  const panel = document.querySelector('#display-panel');
  if (!panel) return;
  const diverging = () => isDiverging(metricType(measure));
  const on = (sel, ev, fn) => panel.querySelector(sel).addEventListener(ev, e => runMapUpdate('Updating map display…', signal => fn(e, signal)));
  on('#color-palette', 'change', e => { settings[diverging() ? 'dpal' : 'spal'] = e.target.value; paint(); });
  on('#color-lo', 'change', e => { settings[diverging() ? 'dlo' : 'slo'] = e.target.value; paint(); });
  on('#color-hi', 'change', e => { settings[diverging() ? 'dhi' : 'shi'] = e.target.value; paint(); });
  on('#scale-center', 'change', (e, signal) => updateScale({ c:e.target.value }, signal));
  on('#scale-range', 'change', (e, signal) => {
    const patch = { r:e.target.value };
    if (e.target.value === 'custom') {
      const sc = scale(measure), k = percentUnits(measure) ? 100 : 1;
      patch.lo = String(+(sc.lo * k).toFixed(2)); patch.hi = String(+(sc.hi * k).toFixed(2));
    }
    return updateScale(patch, signal);
  });
  on('#scale-min', 'change', (e, signal) => updateScale({ lo:e.target.value }, signal));
  on('#scale-max', 'change', (e, signal) => updateScale({ hi:e.target.value }, signal));
  on('#scale-bins', 'change', (e, signal) => updateScale({ b:e.target.value }, signal));
  on('#scale-classes', 'change', (e, signal) => updateScale({ k:e.target.value }, signal));
  on('#scale-log', 'change', (e, signal) => updateScale({ log:e.target.checked ? '1' : '0' }, signal));
  for (const [id, key] of Object.entries({ '#fill-opacity':'op', '#outline-opacity':'ol', '#outline-width':'bw' })) on(id, 'change', e => { settings[key] = String(e.target.value); paint(); });
  for (const [id, key] of Object.entries({ '#outline-on':'ln', '#overlay-county':'oc', '#overlay-cd':'od' })) on(id, 'change', e => { settings[key] = e.target.checked ? '1' : '0'; paint(); });
  on('#display-reset', 'click', (_, signal) => { Object.assign(settings, defaults); for (const key of [...scaleState.keys()]) if (key.startsWith(`${unit}__`)) scaleState.delete(key); viewRange = null; return applyDisplay(signal); });
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
  const showing = document.querySelector('#measure').selectedOptions[0].textContent;
  tooltip.innerHTML = `<strong>${escapeHTML(label)}</strong>${escapeHTML(showing)}: ${escapeHTML(valueText(props))}<br>${measure === 'mean' ? '' : `Projected share: ${escapeHTML(pct(props.mean))}<br>`}90% interval: ${escapeHTML(pct(props.q05))}–${escapeHTML(pct(props.q95))}<br><span class="note">Click for details</span>`;
  const rect = pane.getBoundingClientRect();
  let x = event.originalEvent.clientX - rect.left + 13;
  let y = event.originalEvent.clientY - rect.top + 13;
  x = Math.min(x, rect.width - 265);
  y = Math.min(y, rect.height - 125);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
  tooltip.hidden = false;
}

// Reference values for scale centers: the statewide forecast and each baseline's statewide result and shift.
export function setReference(headline, shifts, shortLabels) {
  const combined = headline.find(row => row.component === 'combined');
  reference = {
    stateShare: combined ? +combined.mean : null,
    baselines: shifts.filter(row => row.component === 'combined').map(row => ({ baseline:row.baseline, short:shortLabels[row.baseline] || row.label, baseline_2p:+row.baseline_2p, shift_mean:+row.shift_mean })),
  };
  drawLegend();
}

export function viewBounds() {
  if (!map) return null;
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

// Choosing a place from the list brings its level onto the map and fits the view to it. The right padding clears the floating panels on wide screens.
const boxes = new Map();
window.addEventListener('zoom-place', ({ detail:{ level, id } }) => runMapUpdate('Loading selected place…', async signal => {
  if (!boxes.has(level)) boxes.set(level, fetch(`${base}data/bounds_${level}.json`).then(r => {
    if (!r.ok) throw new Error('Place bounds could not be loaded.');
    return r.json();
  }).catch(error => { boxes.delete(level); throw error; }));
  const box = (await boxes.get(level))[id];
  signal.throwIfAborted();
  if (!box || !map) return;
  if (level !== unit) await setUnit(level, signal);
  const wide = window.innerWidth > 700;
  map.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding:wide ? { top:70, bottom:50, left:60, right:460 } : 30, maxZoom:level === 'precinct' ? 12 : 10, duration:700 });
}));

export const initialMeasure = () => params.get('m');

function syncUnit(next) {
  levelSettings.set(unit, { ...settings });
  unit = next;
  Object.assign(settings, levelSettings.get(unit));
  if (isMapBusy()) showTileProgress();
  document.querySelectorAll('[data-unit]').forEach(button => {
    const active = button.dataset.unit === unit;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (map?.getLayer('county-fill')) {
    for (const level of levelKeys) {
      map.setLayoutProperty(layerName(level), 'visibility', levelVisible(level) ? 'visible' : 'none');
      map.setLayoutProperty(`border-${level}`, 'visibility', levelVisible(level) ? 'visible' : 'none');
    }
  }
  const note = document.querySelector('#level-note');
  if (note) note.hidden = unit !== 'cd';
  tooltip.hidden = true;
  window.dispatchEvent(new CustomEvent('unit-change', { detail:unit }));
}

export async function setUnit(next, signal) {
  signal?.throwIfAborted();
  syncUnit(next);
  await applyDisplay(signal);
}

export async function setMeasure(next, meta, signal) {
  const request = ++measureRequest;
  measure = next;
  if (meta) metricKinds.set(next, meta.kind);
  try { await ensureValues(); } catch (error) { if (request === measureRequest) throw error; }
  signal?.throwIfAborted();
  if (request !== measureRequest) return;
  paint();
  scheduleFit();
  tooltip.hidden = true;
}

export function setTheme(next) {
  if (!styles[next] || theme === next) return;
  theme = next;
  pane.dataset.theme = theme;
  pane.style.background = basemapBackground[theme];
  drawLegend();
  announce();
  if (map) map.setStyle(styles[theme]);
}

// Count actual tile requests in this transaction; metadata stages have no denominator.
const requestedTiles = new Set(), pendingTiles = new Set();
let dataReady = false;
const geographyName = () => ({county:'counties',precinct:'precincts',cd:'districts',cousub:'subdivisions'})[unit];
function showTileProgress() {
  const total = [...requestedTiles].filter(key => key.startsWith(`${unit}:`)).length;
  const pending = [...pendingTiles].filter(key => key.startsWith(`${unit}:`)).length;
  setMapProgress(geographyName(), dataReady && total ? Math.min(99, Math.floor(100 * (total - pending) / total)) : null);
}
function trackTile(event, loading) {
  if (!isMapBusy() || !levelKeys.includes(event.sourceId) || !event.coord) return;
  const key = `${event.sourceId}:${event.coord.key}`;
  requestedTiles.add(key);
  if (loading) pendingTiles.add(key); else pendingTiles.delete(key);
  showTileProgress();
}

function waitForIdle(signal) {
  return new Promise((resolve, reject) => {
    const clean = () => { map.off('idle', rendered); map.off('error', failed); signal.removeEventListener('abort', aborted); };
    const rendered = () => {
      if (map.loaded() && !map.isMoving() && map.getLayer(layerName(unit))) { clean(); resolve(); }
    };
    const failed = event => { clean(); reject(event.error || new Error('Map resources could not be loaded.')); };
    const aborted = () => { clean(); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    map.on('idle', rendered); map.on('error', failed); signal.addEventListener('abort', aborted, { once:true });
    map.triggerRepaint();
  });
}
configureMapLoading({
  start:() => { dataReady = false; requestedTiles.clear(); pendingTiles.clear(); showTileProgress(); },
  wait:async signal => {
    if (!map) return;
    dataReady = true;
    showTileProgress();
    await waitForIdle(signal);
    refitView();
    await waitForIdle(signal);
    setMapProgress(geographyName(), 100);
    if (message.textContent.startsWith('Map update failed:')) message.hidden = true;
  },
  report:error => { message.textContent = `Map update failed: ${error.message || error}`; message.hidden = false; console.error(error); },
  stop:() => map?.stop(),
});

export function initMap(select) {
  onSelect = select;
  pane.dataset.theme = theme;
  pane.style.background = basemapBackground[theme];
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  map = new maplibregl.Map({ container:'map', style:styles[theme], bounds, fitBoundsOptions: { padding: 28 }, attributionControl: false, cooperativeGestures: false });
  map.on('sourcedataloading', event => trackTile(event, true));
  map.on('sourcedata', event => trackTile(event, false));
  map.on('moveend', () => {
    window.dispatchEvent(new Event('view-change'));
    if (!isMapBusy()) runMapUpdate('Loading map view…', async () => {});
  });
  // Attribution first so it takes the bottom line of the corner, below the zoom buttons and clear of the legend.
  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
  map.on('style.load', () => {
    applyMapLabels(map, theme);
    // Fills and overlays go beneath the basemap's labels so place names stay readable. Styles differ
    // (OpenFreeMap Dark has a water-label layer before its roads), so insert below the trailing run of
    // symbol layers and lift any earlier symbol layer above our layers.
    const styleLayers = map.getStyle().layers;
    let start = styleLayers.length;
    while (start > 0 && styleLayers[start - 1].type === 'symbol') start--;
    const labels = styleLayers[start]?.id;
    const earlyLabels = styleLayers.slice(0, start).filter(layer => layer.type === 'symbol').map(layer => layer.id);
    const bg = map.getStyle().layers.find(layer => layer.type === 'background')?.paint?.['background-color'];
    if (typeof bg === 'string') pane.style.background = bg;
    for (const level of levelKeys) {
      if (map.getLayer(layerName(level))) continue;
      if (!map.getSource(level)) map.addSource(level, { type:'vector', url:tileURL(levels[level].tiles), promoteId:'region_id' });
      map.addLayer({ id:layerName(level), type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:levelVisible(level) ? 'visible' : 'none' }, paint:{ 'fill-color':colorExpression(measure, level), 'fill-opacity':fillOpacity(), 'fill-outline-color':'rgba(0,0,0,0)' } }, labels);
    }
    for (const level of levelKeys) map.addLayer({id:`border-${level}`,type:'line',source:level,'source-layer':'regions',layout:{visibility:levelVisible(level)?'visible':'none'},paint:{'line-color':outline(),'line-width':+settings.bw}},labels);
    for (const [level, style] of Object.entries(overlayStyle)) {
      if (map.getLayer(`overlay-${level}`)) continue;
      map.addLayer({ id:`overlay-${level}`, type:'line', source:level, 'source-layer':'regions', layout:{ visibility:settings[level === 'county' ? 'oc' : 'od'] === '1' ? 'visible' : 'none', 'line-join':'round' }, paint:{ 'line-color':style[theme], 'line-width':style.width, ...(style.dash ? { 'line-dasharray':style.dash } : {}) } }, labels);
    }
    for (const id of earlyLabels) map.moveLayer(id, labels);
    message.hidden = true;
    scheduleFit();
  });
  map.on('moveend', scheduleFit);
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
    failMapUpdate(e.error || new Error('Map resources could not be loaded.'));
    const error = String(e.error?.message || e.error || '');
    if (/pmtiles|regions|counties|404|fetch/i.test(error)) {
      message.textContent = 'Map tiles could not be loaded. The other data remains available.';
      message.hidden = false;
    }
    console.error('Map error:', e.error);
  });
  document.querySelector('#reset-map').addEventListener('click', () => runMapUpdate('Resetting map view…', () => map.fitBounds(bounds, { padding:28, duration:450 })));
  pane.addEventListener('click', event => {
    const button = event.target.closest('.maplibregl-ctrl-zoom-in,.maplibregl-ctrl-zoom-out');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    runMapUpdate('Loading map view…', () => button.classList.contains('maplibregl-ctrl-zoom-in') ? map.zoomIn() : map.zoomOut());
  }, true);
  initDisplayControls();
  syncUnit(unit);
  return map;
}
