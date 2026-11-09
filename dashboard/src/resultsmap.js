import maplibregl from 'maplibre-gl';
import { base, csv, pct, count, signed, escapeHTML } from './data.js';
import { mapBasics, compareGreyColors } from './map.js';
import { featureStates, stateWidth, rowMarker } from './highlight.js';
import { stops as palStops, partisanCenter, partisanClamp, swatchButton } from './palette.js';
import { ensureStore, storeIfLoaded, evaluate, metricArray, valueExpressions, mapExpressions, STATUS, raceNodes, raceOf, levelInfo, metrics as cmpMetrics, minOptions, tpOf, shareOf, indexOf, crossOffice, crossesSources, sourceCaveat, is2026Result } from './compare.js';

// The Results tab map. It has its own state (level, measure, pair, filters), kept apart from the Forecast tab's compare state,
// and shades places from the published 2026 results and history files through compare.js. Nothing is estimated here.
const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const levelOrder = ['precinct', 'county', 'cd', 'cousub', 'puma'];
const levelNames = { precinct:'Precincts', county:'Counties', cd:'Congressional districts', cousub:'Subdivisions', puma:'PUMAs' };
// bw is empty until the user sets it, so the default follows the level (thinner borders for dense precincts).
const rs = { level:'county', measure:'res_share', from:'sen24', to:'sen26', min:0, county:'', range:'state', bw:'', fo:'87', bo:'30', ln:'1', hw:'1', fb:'1' };
const defaults = { ...rs };
const urlKeys = { level:'rlv', measure:'rm', from:'rf', to:'rt', min:'rmin', county:'rc', range:'rr', bw:'rbw', fo:'rfo', bo:'rbo', ln:'rln', hw:'rhw', fb:'rfb' };
let available = [], present = [], map = null, started = false, styleReady = false, decorated = false, active = false;
let cur = null, token = 0, hover = null, selected = null, surnames = null;
let tipId = null, tipSize = { w:0, h:0 }, frame = 0;
const added = new Set();
const sortState = { key:'votes', dir:-1 };
const TABLE_CAP = 500;

const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
const sign = v => v > 0 ? '+' : v < 0 ? '−' : '';
const votesText = v => `${sign(v)}${count(Math.abs(v))}`;
const share1 = v => Number.isFinite(v) ? pct(v, 1) : '–';
const fmtOf = {
  share:pct, shift:signed, diff:votesText, logratio:v => `×${Math.exp(v).toFixed(2)}`, votes:count, income:v => `$${count(v)}`, pctshare:pct,
};

// ---- Measures ----
const demographics = [
  ['hisp_cvap_share', 'Hispanic share of citizen voting-age population', 'pctshare'], ['white_cvap_share', 'White share of citizen voting-age population', 'pctshare'],
  ['black_cvap_share', 'Black share of citizen voting-age population', 'pctshare'], ['ba_plus_share', "Adults with a bachelor's degree or more", 'pctshare'],
  ['med_income', 'Median household income', 'income'], ['population', 'Population', 'votes'],
];
const earlyColumns = [['pct_registered', '% of registered'], ['pct_of_2022', '% of 2022'], ['pct_of_expected', '% of expected']];
const earlyFile = level => ['precinct', 'county', 'puma'].includes(level) && present.includes(`early_vote_map_${level}.csv`) ? `early_vote_map_${level}.csv` : null;
function measureList(level) {
  const list = [
    { key:'res_share', group:'Result', label:'Talarico two-party share', scale:'share', fmt:'share', election:true },
    { key:'res_margin', group:'Result', label:'Margin (Talarico minus Paxton votes)', scale:'diff', fmt:'diff', election:true },
    { key:'res_votes', group:'Result', label:'Two-party votes cast', scale:'seq', fmt:'votes', election:true },
    ...(earlyFile(level) ? earlyColumns.map(([col, text]) => ({ key:`ev_${col}`, group:'Result', label:`Early ballots (final day): ${text}`, scale:'seq', fmt:'pctshare', early:col })) : []),
    ...cmpMetrics.filter(m => m.key !== 'rratio').map(m => ({ key:`cmp_${m.key}`, group:'Shift vs another race', label:m.label, pair:'chosen', metric:m.key, election:true })),
    { key:'fc_shift', group:'Shift vs forecast', label:'Result minus pre-election forecast (Talarico share)', pair:'forecast', metric:'shift', election:true },
    { key:'fc_net', group:'Shift vs forecast', label:'Result minus forecast, net Democratic votes', pair:'forecast', metric:'net', election:true },
  ];
  if (level === 'precinct') list.push(
    { key:'sur_hisp', group:'Surname shares (modeled estimates)', label:'Hispanic surname share (modeled estimate)', scale:'seq', fmt:'pctshare', surname:'hisp_surname_share' },
    { key:'sur_black', group:'Surname shares (modeled estimates)', label:'Black surname share (modeled estimate)', scale:'seq', fmt:'pctshare', surname:'black_surname_share' },
  );
  for (const [col, label, fmt] of demographics) list.push({ key:`dm_${col}`, group:'Demographics', label, scale:'seq', fmt, demog:col });
  return list;
}
const metricScale = { shift:'shift', rshift:'shift', ratio:'logratio', rratio:'logratio', net:'diff' };
const metricFmt = { shift:'shift', rshift:'shift', ratio:'logratio', rratio:'logratio', net:'diff' };
const defOf = () => measureList(rs.level).find(d => d.key === rs.measure) || measureList(rs.level).find(d => d.key === defaults.measure);
const effCounty = () => rs.level === 'precinct' ? rs.county : '';
const pairOf = def => ({ from:def.pair === 'forecast' ? 'f26' : rs.from, to:def.pair === 'forecast' ? 'sen26' : rs.to, min:rs.min, county:effCounty(), profile:'', metric:def.metric });

// Cumulative early-vote files hold one row per area per day; the map uses each area's row on the latest date.
const earlyCache = new Map();
async function earlyArray(store, column) {
  const file = earlyFile(store.level);
  if (!earlyCache.has(file)) earlyCache.set(file, csv(file).then(rows => {
    let last = '';
    for (const r of rows) if (r.date > last) last = r.date;
    return new Map(rows.filter(r => r.date === last).map(r => [r.region_id, r]));
  }));
  const byId = await earlyCache.get(file);
  return Float64Array.from(store.ids, id => num(byId.get(id)?.[column]));
}
const uses26 = (def, pair) => pair ? is2026Result(pair.from) || is2026Result(pair.to) : !!def.election;
// County values for the precinct fallback: the same measure and pair from the county store, for measures that do not depend on a place's size.
async function countyFallback(def, pair) {
  if (rs.level !== 'precinct' || rs.fb !== '1' || !uses26(def, pair)) return null;
  const scale = def.pair ? metricScale[def.metric] : def.scale;
  if (!['share', 'shift', 'logratio'].includes(scale)) return null;
  const store = await ensureStore('county'), values = {};
  let array, ok = null;
  if (def.pair) { const ev = evaluate(store, pair.from, pair.to, { ...pair, min:0, county:'' }); array = metricArray(ev, def.metric); ok = ev.status; }
  else array = shareOf(store, 'sen26');
  for (let i = 0; i < store.n; i++) if ((!ok || ok[i] === STATUS.ok) && Number.isFinite(array[i])) values[store.ids[i]] = Math.round(array[i] * 1e6) / 1e6;
  return { values, store };
}
async function surnameArray(store, column) {
  surnames ||= csv(levelInfo.precinct.extra).then(rows => new Map(rows.map(r => [r.region_id, r])));
  const byId = await surnames;
  return Float64Array.from(store.ids, id => num(byId.get(id)?.[column]));
}
// Values, status and display settings for the active measure at the active level.
async function compute() {
  const def = defOf(), store = await ensureStore(rs.level), county = effCounty();
  if (def.pair) {
    const pair = pairOf(def), ev = evaluate(store, pair.from, pair.to, pair);
    return { def, store, pair, ev, array:metricArray(ev, def.metric), status:ev.status, counts:ev.counts, scale:metricScale[def.metric], fmt:metricFmt[def.metric], min:rs.min,
      expr:mapExpressions(rs.level, def.metric, pair), fallback:await countyFallback(def, pair) };
  }
  const n = store.n, status = new Uint8Array(n), counts = { shown:0, below:0, missing:0, filtered:0, total:n };
  let array, tp = null;
  if (def.election) {
    tp = tpOf(store, 'sen26');
    const dem = store.dem.sen26, rep = store.rep.sen26, sh = shareOf(store, 'sen26');
    array = Float64Array.from({ length:n }, (_, i) => def.key === 'res_share' ? sh[i] : def.key === 'res_margin' ? dem[i] - rep[i] : tp[i]);
  } else if (def.surname) array = await surnameArray(store, def.surname);
  else if (def.early) array = await earlyArray(store, def.early);
  else array = Float64Array.from(store.demog[def.demog]);
  for (let i = 0; i < n; i++) {
    if (county && store.county[i] !== county) { status[i] = STATUS.filtered; counts.filtered++; }
    else if (!Number.isFinite(array[i]) || (def.election && !(tp[i] > 0))) { status[i] = STATUS.missing; counts.missing++; }
    else if (def.election && tp[i] < rs.min) { status[i] = STATUS.below; counts.below++; }
    else { status[i] = STATUS.ok; counts.shown++; }
  }
  const min = def.election ? rs.min : 0;
  const expr = valueExpressions(store, `v|${def.key}|${rs.level}|${min}|${county}`, () => array.map((v, i) => status[i] === STATUS.ok ? v : NaN), status, counts.filtered, min);
  return { def, store, pair:null, ev:null, array, status, counts, scale:def.scale, fmt:def.fmt, min, expr, fallback:await countyFallback(def, null) };
}

// ---- Color scale ----
const quant = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
const isDiverging = kind => ['share', 'shift', 'logratio', 'diff'].includes(kind);
const rangeOptions = kind => [['state', 'Fit to state (5th–95th pct.)'], ['view', 'Fit to view (5th–95th pct.)'], ...(kind === 'share' || kind === 'shift' ? [.05, .1, .2, .3].map(p => [`p${p}`, `±${Math.round(100 * p)} pts`]) : [])];
function sortedValues(c, ids) {
  const out = [];
  if (ids) for (const id of ids) { const i = indexOf(c.store, id); if (i !== undefined && c.status[i] === STATUS.ok && Number.isFinite(c.array[i])) out.push(c.array[i]); }
  else for (let i = 0; i < c.store.n; i++) if (c.status[i] === STATUS.ok && Number.isFinite(c.array[i])) out.push(c.array[i]);
  return out.sort((a, b) => a - b);
}
function buildScale(c, viewIds) {
  const b = mapBasics(), kind = c.scale;
  const range = rangeOptions(kind).some(([v]) => v === rs.range) ? rs.range : 'state';
  const all = sortedValues(c), src = range === 'view' && viewIds?.length ? sortedValues(c, viewIds) : all;
  if (isDiverging(kind)) {
    const base0 = kind === 'share' ? .5 : 0, preset = /^p([\d.]+)$/.exec(range);
    let half = preset ? +preset[1] : src.length ? Math.max(Math.abs(quant(src, .05) - base0), Math.abs(quant(src, .95) - base0)) : .1;
    if (!(half > 0)) half = kind === 'share' || kind === 'shift' ? .05 : 1;
    const partisanPts = kind === 'share' || kind === 'shift';
    const center = base0 + (partisanPts ? partisanCenter() : 0), h = partisanPts ? partisanClamp(half) : half;
    const list = palStops('partisan', b.theme), ts = Array.from({ length:9 }, (_, k) => k / 8);
    return { diverging:true, center, lo:center - h, hi:center + h, stops:ts.map(t => center + (t - .5) * 2 * h), colors:ts.map(t => b.colorAt(list, t, 'shift')), range };
  }
  let lo = src.length ? quant(src, .05) : 0, hi = src.length ? quant(src, .95) : 1;
  if (!(hi > lo)) hi = lo + 1;
  const list = palStops('sequential', b.theme), ts = Array.from({ length:7 }, (_, k) => k / 6);
  return { diverging:false, lo, hi, stops:ts.map(t => lo + t * (hi - lo)), colors:ts.map(t => b.colorAt(list, t, 'seq')), range };
}
function colorExpression(c, scale) {
  const g = compareGreyColors(), e = c.expr;
  const ramp = value => ['interpolate', ['linear'], value, ...scale.stops.flatMap((v, i) => [v, scale.colors[i]])];
  const fb = fallbackTest(c);
  return ['case', e.nodata, g.nodata, ...(e.filtered ? [e.filtered, g.filtered] : []), ...(fb ? [fb, ramp(['get', countyId, ['literal', c.fallback.values]])] : []), e.missing, g.missing, ...(e.below ? [e.below, g.below] : []), ramp(e.value)];
}
// A precinct with no value of its own takes its county's value (the county id is the first three characters of the precinct id).
const countyId = ['slice', ['to-string', ['get', 'region_id']], 0, 3];
const fallbackTest = c => c.fallback ? ['all', c.expr.missing, ['has', countyId, ['literal', c.fallback.values]]] : null;
const fillOpacity = c => {
  const o = +rs.fo / 100, fb = c && fallbackTest(c);
  return fb ? ['case', fb, .6 * o, o] : o;
};
const borderWidth = () => rs.bw !== '' ? +rs.bw : rs.level === 'precinct' ? .2 : .7;

// ---- Layers ----
const ids = level => ({ fill:`rs-fill-${level}`, line:`rs-line-${level}`, hi:`rs-hi-${level}`, src:`rs-${level}` });
function addLevel(level) {
  if (!map || !styleReady || added.has(level)) return;
  const b = mapBasics(), layers = map.getStyle().layers, name = ids(level);
  let first = layers.length;
  while (first > 0 && layers[first - 1].type === 'symbol') first--;
  const below = layers[first]?.id;
  map.addSource(name.src, { type:'vector', url:b.tileURL(b.tiles[level]), promoteId:'region_id' });
  map.addLayer({ id:name.fill, type:'fill', source:name.src, 'source-layer':'regions', layout:{ visibility:'none' }, paint:{ 'fill-color':compareGreyColors().nodata, 'fill-opacity':.85, 'fill-outline-color':'rgba(0,0,0,0)' } }, below);
  map.addLayer({ id:name.line, type:'line', source:name.src, 'source-layer':'regions', layout:{ visibility:'none' }, paint:{ 'line-color':b.theme === 'dark' ? 'rgba(220,230,235,.35)' : 'rgba(40,55,60,.3)', 'line-width':level === 'precinct' ? .25 : .5 } }, below);
  map.addLayer({ id:name.hi, type:'line', source:name.src, 'source-layer':'regions', layout:{ visibility:'none' }, paint:{ 'line-color':b.theme === 'dark' ? '#ffffff' : '#111a1f', 'line-width':stateWidth('on', 2.4) } }, below);
  if (!decorated) {
    decorated = true;
    b.highways(below, map);
    if (below) for (const layer of layers.slice(0, first)) if (layer.type === 'symbol') map.moveLayer(layer.id, below);
    b.labels(map);
  }
  added.add(level);
}
function showLevel(level) {
  for (const l of added) for (const part of ['fill', 'line', 'hi']) map.setLayoutProperty(ids(l)[part], 'visibility', l === level ? 'visible' : 'none');
}
const hi = featureStates('on'), rowsMark = rowMarker();
function setHighlight() {
  if (!map) return;
  for (const l of added) hi.set(map, ids(l).src, l === rs.level ? [selected, hover] : []);
}

function applyDisplay(c) {
  const name = ids(rs.level), b = mapBasics();
  map.setPaintProperty(name.fill, 'fill-opacity', fillOpacity(c));
  map.setPaintProperty(name.line, 'line-color', `rgba(${b.theme === 'dark' ? '240,247,247' : '40,60,65'},${rs.ln === '1' ? +rs.bo / 100 : 0})`);
  map.setPaintProperty(name.line, 'line-width', borderWidth());
  if (map.getLayer('highways')) map.setLayoutProperty('highways', 'visibility', rs.hw === '1' ? 'visible' : 'none');
}

// ---- Painting ----
function viewIds() {
  if (!map || !added.has(rs.level)) return [];
  return [...new Set(map.queryRenderedFeatures({ layers:[ids(rs.level).fill] }).map(f => String(f.properties.region_id)))];
}
async function paint({ keepScale = false } = {}) {
  const mine = ++token;
  let c;
  try { c = await compute(); } catch (error) { console.error(error); $('#rs-note').textContent = `The results map could not load: ${error.message}`; return; }
  if (mine !== token) return;
  cur = c; tipId = null;
  const scale = buildScale(c, rs.range === 'view' ? viewIds() : null);
  cur.drawn = scale;
  if (map && styleReady) {
    addLevel(rs.level);
    showLevel(rs.level);
    map.setPaintProperty(ids(rs.level).fill, 'fill-color', colorExpression(c, scale));
    applyDisplay(c);
    setHighlight();
  }
  renderLegend(c, scale); renderNote(c); drawTable(c); syncControls(c); syncURL();
}
const swatchKind = c => isDiverging(c.scale) ? 'partisan' : 'sequential';
const endNames = { share:['Paxton', 'Talarico'], shift:['Less Democratic', 'More Democratic'], logratio:['Fewer votes', 'More votes'], diff:['Net Paxton', 'Net Talarico'] };
function renderLegend(c, scale) {
  const fmt = fmtOf[c.fmt], g = compareGreyColors();
  const grad = scale.colors.map((color, i) => `${color} ${(100 * i / (scale.colors.length - 1)).toFixed(1)}%`).join(',');
  const picks = scale.diverging ? [scale.lo, scale.center, scale.hi] : [scale.lo, (scale.lo + scale.hi) / 2, scale.hi];
  const chip = (color, text) => `<div class="legend-nodata"><span style="background:${color}"></span>${escapeHTML(text)}</div>`;
  const title = c.pair && c.def.pair === 'chosen' ? `${raceOf(c.pair.from).short} to ${raceOf(c.pair.to).short}: ${c.def.label}` : c.def.label;
  const gone = uses26(c.def, c.pair) ? (rs.level === 'precinct' ? 'No 2026 precinct returns here' : 'Returns incomplete for this area') : 'No data';
  const lines = [];
  let used = 0;
  if (c.fallback) for (let i = 0; i < c.store.n; i++) if (c.status[i] === STATUS.missing && c.fallback.values[c.store.ids[i].slice(0, 3)] !== undefined) used++;
  if (c.def.early) lines.push('Early ballots only, cumulative to the latest date; this is not total turnout.');
  if (c.ev) lines.push(`Statewide (places shown): ${raceOf(c.pair.from).short} ${share1(c.ev.stateShareA)}, ${raceOf(c.pair.to).short} ${share1(c.ev.stateShareB)}, shift ${signed(c.ev.stateShift)}.`);
  lines.push(`${count(c.counts.shown)} of ${count(c.counts.total - c.counts.filtered)} places shown.`);
  if (c.pair && c.def.pair === 'chosen' && crossOffice(c.pair.from, c.pair.to)) lines.push('Cross-office comparison: the shift includes candidate differences, not only changes in the electorate.');
  if (c.pair && c.def.pair === 'chosen' && crossesSources(c.pair.from, c.pair.to)) lines.push(sourceCaveat);
  if (c.def.surname) lines.push('Modeled estimate from surname rosters, not a count of voters.');
  $('#rs-legend').innerHTML = `<div class="eday-legend-title">${escapeHTML(title)}</div>
    <div class="eday-ramp" style="background:linear-gradient(90deg,${grad})"></div>
    <div class="legend-edges">${picks.map((v, i) => `<span style="left:${i === 0 ? 0 : i === 2 ? 100 : 50}%;${i === 0 ? 'transform:none' : i === 2 ? 'transform:translateX(-100%)' : ''}">${escapeHTML(v === 0 && c.scale === 'shift' ? '0' : fmt(v))}</span>`).join('')}</div>
    ${scale.diverging ? `<div class="legend-ends"><span>${endNames[c.scale][0]}</span><span>${endNames[c.scale][1]}</span></div>` : ''}
    ${used ? `<div class="legend-nodata"><span style="background:linear-gradient(90deg,${grad});opacity:.6"></span>County result (no precinct returns)</div>` : ''}${c.counts.missing - used > 0 ? chip(g.missing, gone) : ''}${c.min > 0 && c.def.election ? chip(g.below, `Too few votes (under ${count(c.min)} two-party)`) : ''}${c.counts.filtered ? chip(g.filtered, 'Excluded by filters') : ''}
    ${lines.map(t => `<div class="eday-legend-note">${escapeHTML(t)}</div>`).join('')}`;
  $('#rs-legend .eday-legend-title').append(' ', swatchButton(swatchKind(c)));
}

// Data limits, stated from the loaded files.
function coverage() {
  const p = storeIfLoaded('precinct'), k = storeIfLoaded('county');
  if (!p || !k) return null;
  const tp = tpOf(p, 'sen26'), kt = tpOf(k, 'sen26'), counties = new Set();
  let sum = 0, all = 0;
  for (let i = 0; i < p.n; i++) if (tp[i] > 0) { counties.add(p.county[i]); sum += tp[i]; }
  for (let i = 0; i < k.n; i++) all += kt[i];
  return { counties:counties.size, of:k.n, share:all > 0 ? sum / all : NaN, unmatched:p.extra.reduce((s, v) => s + (v ? 0 : 1), 0), precincts:p.n };
}
function renderNote(c) {
  const parts = [];
  if (c.def.election || c.def.pair) {
    if (rs.level === 'county') parts.push('County 2026 totals are exact and equal the recorded final results.');
    else if (rs.level === 'precinct') {
      const v = coverage();
      parts.push(v ? `Precinct returns cover ${count(v.counties)} of ${count(v.of)} counties and about ${Math.round(100 * v.share)}% of the statewide two-party vote. The other counties report county totals only, so their precincts take the county result at reduced opacity${rs.fb === '1' ? '' : ' (fill is switched off, so they are blank)'}.` : 'Counties without precinct returns are blank at this level; use Counties to see them.');
      if (v?.unmatched) parts.push(`${count(v.unmatched)} of ${count(v.precincts)} precincts on the map have no row in the results file and are blank.`);
      parts.push('Precinct history in split precincts is allocated by each child precinct’s 2026 votes, so counts there are approximate; shares are exact.');
    } else parts.push('An area shows 2026 results only where precinct returns cover at least 98% of its 2026 vote; other areas are blank.');
  }
  parts.push('Results are unofficial; the canvass is pending.');
  $('#rs-note').textContent = parts.join(' ');
}

// ---- Table ----
const tableCols = c => [
  { key:'name', label:rs.level === 'county' ? 'County' : levelNames[rs.level], text:true },
  { key:'votes', label:'2026 two-party votes' },
  { key:'s26', label:'2026 Talarico share' },
  ...(c.pair ? [{ key:'sc', label:c.def.pair === 'forecast' ? 'Pre-election forecast' : `${raceOf(c.pair.from).short} share` }] : []),
  { key:'value', label:c.def.label },
];
function rowsOf(c) {
  const { store } = c, tp = tpOf(store, 'sen26'), sh = shareOf(store, 'sen26'), cmp = c.pair ? shareOf(store, c.pair.from) : null;
  const out = [];
  for (let i = 0; i < store.n; i++) {
    if (c.status[i] === STATUS.filtered) continue;
    out.push({ i, id:store.ids[i], name:store.labels[i], votes:tp[i], s26:sh[i], sc:cmp ? cmp[i] : NaN, value:c.status[i] === STATUS.ok ? c.array[i] : NaN });
  }
  return out;
}
function drawTable(c) {
  const cols = tableCols(c);
  if (!cols.some(k => k.key === sortState.key)) { sortState.key = 'votes'; sortState.dir = -1; }
  const rows = rowsOf(c).sort((a, b) => {
    const p = a[sortState.key], q = b[sortState.key];
    if (sortState.key === 'name') return String(p).localeCompare(String(q)) * sortState.dir;
    const fp = Number.isFinite(p), fq = Number.isFinite(q);
    return fp && fq ? (p - q) * sortState.dir : fp ? -1 : fq ? 1 : 0;
  });
  const shown = rows.slice(0, TABLE_CAP), fmt = fmtOf[c.fmt];
  $('#rs-table-title').textContent = levelNames[rs.level];
  const cell = (k, r) => k.key === 'name' ? escapeHTML(r.name) : k.key === 'votes' ? (r.votes > 0 ? count(r.votes) : '–') : k.key === 's26' || k.key === 'sc' ? share1(r[k.key]) : Number.isFinite(r.value) ? fmt(r.value) : '–';
  $('#rs-table').innerHTML = `<div class="table-scroll evt-table"><table><thead><tr>${cols.map(k => `<th class="${k.text ? 'name' : ''}" aria-sort="${k.key === sortState.key ? (sortState.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k.key}">${escapeHTML(k.label)}</button></th>`).join('')}</tr></thead>
    <tbody>${shown.map(r => `<tr data-id="${escapeHTML(r.id)}" tabindex="0">${cols.map(k => `<td class="${k.text ? 'name' : ''}">${cell(k, r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">${rows.length > TABLE_CAP ? `Showing the first ${count(TABLE_CAP)} of ${count(rows.length)} places in this order. ` : ''}Shares are Talarico’s share of the two-party vote. A dash means the place has no data for that column.</p>`;
  rowsMark.index($('#rs-table'));
  markTable();
}
function markTable() { rowsMark.mark([selected, hover]); }

// ---- Tooltip ----
function tooltipHTML(id) {
  const c = cur;
  if (!c) return '';
  const i = indexOf(c.store, id);
  if (i === undefined) return `<strong>${escapeHTML(id)}</strong>No data`;
  const tp = tpOf(c.store, 'sen26')[i], sh = shareOf(c.store, 'sen26')[i], lines = [];
  const cid = String(c.store.ids[i]).slice(0, 3), fbValue = c.fallback && c.status[i] === STATUS.missing ? c.fallback.values[cid] : undefined;
  if (fbValue !== undefined) {
    const at = indexOf(c.fallback.store, cid);
    lines.push(`No precinct returns; showing the ${at === undefined ? cid : c.fallback.store.labels[at]} county result`, `${c.def.label} (county): ${fmtOf[c.fmt](fbValue)}`);
  } else if (tp > 0) lines.push(`2026 Senate: ${share1(sh)} Talarico of ${count(tp)} two-party votes`);
  else if (rs.level === 'precinct') lines.push('Precinct returns not available here; see the county view.');
  else if (Number.isFinite(c.store.cov26[i])) lines.push(`2026 precinct returns incomplete for this area (${(100 * c.store.cov26[i]).toFixed(1)}% covered)`);
  else lines.push('No 2026 returns for this place');
  if (c.pair) {
    const from = shareOf(c.store, c.pair.from)[i], ftp = tpOf(c.store, c.pair.from)[i];
    lines.push(c.def.pair === 'forecast' ? `Pre-election forecast: ${share1(from)}` : `${raceOf(c.pair.from).label}: ${ftp > 0 ? `${share1(from)} of ${count(ftp)} two-party votes` : 'no votes in this race'}`);
    if (Number.isFinite(sh) && Number.isFinite(from)) lines.push(`Shift: ${signed(sh - from)}`);
  } else if (c.def.election) lines.push(`Pre-election forecast: ${share1(shareOf(c.store, 'f26')[i])}`);
  const v = c.array[i];
  if (c.def.early && Number.isFinite(v)) lines.push(`${c.def.label}: ${fmtOf[c.fmt](v)}`);
  else if (!c.def.pair && Number.isFinite(v) && c.def.key !== 'res_share') lines.push(`${c.def.label}: ${fmtOf[c.fmt](v)}${c.def.surname ? ' (estimate)' : ''}`);
  else if (c.def.pair && c.status[i] === STATUS.ok) lines.push(`${c.def.label}: ${fmtOf[c.fmt](v)}`);
  if (c.status[i] === STATUS.below) lines.push(`Below the minimum of ${count(c.min)} two-party votes: not shaded.`);
  if (c.status[i] === STATUS.filtered) lines.push('Excluded by the current filters.');
  return `<strong>${escapeHTML(c.store.labels[i])}</strong>${lines.map(escapeHTML).join('<br>')}`;
}

// ---- Controls and URL ----
function fillSelect(select, options, value) { select.replaceChildren(...options); select.value = value; }
function buildMeasureSelect() {
  const groups = new Map();
  for (const d of measureList(rs.level)) {
    if (!groups.has(d.group)) { const g = document.createElement('optgroup'); g.label = d.group; groups.set(d.group, g); }
    groups.get(d.group).append(new Option(d.label, d.key));
  }
  const select = $('#rs-measure');
  select.replaceChildren(...groups.values());
  if (!measureList(rs.level).some(d => d.key === rs.measure)) rs.measure = defaults.measure;
  select.value = rs.measure;
}
function syncControls(c) {
  for (const b of document.querySelectorAll('#rs-levels button')) { const on = b.dataset.level === rs.level; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
  $('#rs-measure').value = rs.measure;
  $('#rs-compare').hidden = c.def.pair !== 'chosen';
  $('#rs-from').value = rs.from; $('#rs-to').value = rs.to; $('#rs-min').value = String(rs.min);
  $('#rs-county-field').hidden = rs.level !== 'precinct'; $('#rs-county').value = rs.county;
  $('#rs-fb-field').hidden = rs.level !== 'precinct'; $('#rs-fb').checked = rs.fb === '1';
  $('#rs-fo').value = rs.fo; $('#rs-fo-out').textContent = `${rs.fo}%`; $('#rs-ln').checked = rs.ln === '1';
  $('#rs-bw').value = borderWidth(); $('#rs-bw-out').textContent = borderWidth().toFixed(1); $('#rs-bw').disabled = $('#rs-bo').disabled = rs.ln !== '1';
  $('#rs-bo').value = rs.bo; $('#rs-bo-out').textContent = `${rs.bo}%`; $('#rs-hw').checked = rs.hw === '1';
  const options = rangeOptions(c.scale);
  fillSelect($('#rs-range'), options.map(([v, t]) => new Option(t, v)), options.some(([v]) => v === rs.range) ? rs.range : 'state');
}
function syncURL() {
  if (!active) return;
  const url = new URL(location.href);
  for (const [key, name] of Object.entries(urlKeys)) { if (rs[key] === defaults[key]) url.searchParams.delete(name); else url.searchParams.set(name, String(rs[key])); }
  history.replaceState(null, '', url);
}
function readURL() {
  const level = params.get(urlKeys.level);
  if (level && available.includes(level)) rs.level = level;
  else if (!available.includes(rs.level)) rs.level = available[0];
  const m = params.get(urlKeys.measure); if (m && /^[a-z0-9_]{1,48}$/.test(m)) rs.measure = m;
  for (const key of ['from', 'to']) { const v = params.get(urlKeys[key]); if (v && raceOf(v)) rs[key] = v; }
  const min = params.get(urlKeys.min); if (min != null && minOptions.includes(+min)) rs.min = +min;
  const county = params.get(urlKeys.county); if (county && /^\d{3}$/.test(county)) rs.county = county;
  const range = params.get(urlKeys.range); if (range && /^(state|view|p[\d.]+)$/.test(range)) rs.range = range;
  const bw = params.get(urlKeys.bw); if (bw != null && Number.isFinite(+bw) && +bw >= 0 && +bw <= 5) rs.bw = bw;
  for (const key of ['fo', 'bo']) { const v = params.get(urlKeys[key]); if (v != null && /^\d{1,3}$/.test(v) && +v <= 100) rs[key] = v; }
  for (const key of ['ln', 'hw', 'fb']) { const v = params.get(urlKeys[key]); if (v === '0' || v === '1') rs[key] = v; }
}
function setHover(id) { if (hover === id) return; hover = id; setHighlight(); markTable(); }
function setSelection(id) {
  selected = selected === id ? null : id; setHighlight(); markTable();
  if (selected) document.querySelector(`#rs-table tr[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block:'nearest' });
}

function initMap() {
  const b = mapBasics();
  map = new maplibregl.Map({ container:'rs-map', style:b.style, bounds:b.bounds, fitBoundsOptions:{ padding:24 }, attributionControl:false, cooperativeGestures:true });
  map.addControl(new maplibregl.AttributionControl({ compact:true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'top-right');
  map.on('style.load', () => { styleReady = true; decorated = false; added.clear(); hi.reset(); paint(); });
  window.addEventListener('basemap-change', () => { if (!map) return; styleReady = false; map.setStyle(mapBasics().style); });
  const wrap = $('.rs-map-wrap');
  let fitted = false;
  new ResizeObserver(() => { if (!wrap.clientWidth || !wrap.clientHeight) return; map.resize(); if (!fitted) { fitted = true; map.fitBounds(b.bounds, { padding:24, duration:0 }); } }).observe(wrap);
  const tip = $('#rs-tooltip');
  const place = point => {
    const box = map.getContainer().getBoundingClientRect();
    tip.style.left = `${point.x + 14 + tipSize.w > box.width ? Math.max(4, point.x - tipSize.w - 14) : point.x + 14}px`;
    tip.style.top = `${Math.max(6, Math.min(box.height - tipSize.h - 6, point.y - tipSize.h / 2))}px`;
  };
  // One feature query per frame; the tooltip text is rebuilt only when the hovered place changes. Hover touches only the outline filter.
  let point = null;
  map.on('mousemove', e => {
    point = e.point;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const f = styleReady && added.has(rs.level) && map.queryRenderedFeatures(point, { layers:[ids(rs.level).fill] })[0];
      map.getCanvas().style.cursor = f ? 'pointer' : '';
      if (!f) { tip.hidden = true; tipId = null; setHover(null); return; }
      const id = String(f.properties.region_id);
      if (id !== tipId) {
        tip.innerHTML = tooltipHTML(id); tip.hidden = false; tipId = id;
        tipSize = { w:tip.offsetWidth, h:tip.offsetHeight };
      }
      place(point);
      setHover(id);
    });
  });
  map.on('mouseout', () => { cancelAnimationFrame(frame); frame = 0; tip.hidden = true; tipId = null; setHover(null); });
  map.on('click', e => { const f = styleReady && added.has(rs.level) && map.queryRenderedFeatures(e.point, { layers:[ids(rs.level).fill] })[0]; setSelection(f ? String(f.properties.region_id) : null); });
  let timer = null;
  map.on('moveend', () => { if (rs.range !== 'view') return; clearTimeout(timer); timer = setTimeout(() => paint(), 150); });
}

async function setupControls() {
  const levels = $('#rs-levels');
  levels.replaceChildren(...levelOrder.filter(l => available.includes(l)).map(l => { const b = document.createElement('button'); b.type = 'button'; b.dataset.level = l; b.textContent = levelNames[l]; return b; }));
  levels.addEventListener('click', e => {
    const b = e.target.closest('[data-level]'); if (!b || b.dataset.level === rs.level) return;
    rs.level = b.dataset.level; selected = hover = null; buildMeasureSelect(); paint();
  });
  buildMeasureSelect();
  $('#rs-from').replaceChildren(...raceNodes(rs.from)); $('#rs-to').replaceChildren(...raceNodes(rs.to));
  fillSelect($('#rs-min'), minOptions.map(v => new Option(v ? `${count(v)}` : 'None', String(v))), String(rs.min));
  const on = (selector, key, parse = v => v) => $(selector).addEventListener('change', e => { rs[key] = parse(e.target.value); paint(); });
  $('#rs-measure').addEventListener('change', e => { rs.measure = e.target.value; paint(); });
  const check = (selector, key) => $(selector).addEventListener('change', e => { rs[key] = e.target.checked ? '1' : '0'; paint(); });
  check('#rs-fb', 'fb'); check('#rs-ln', 'ln'); check('#rs-hw', 'hw');
  for (const [selector, key] of [['#rs-fo', 'fo'], ['#rs-bw', 'bw'], ['#rs-bo', 'bo']]) $(selector).addEventListener('input', e => { rs[key] = String(e.target.value); if (cur) { applyDisplay(cur); syncControls(cur); syncURL(); } });
  $('#rs-display-reset').addEventListener('click', () => { Object.assign(rs, { bw:'', fo:defaults.fo, bo:defaults.bo, ln:defaults.ln, hw:defaults.hw }); paint(); });
  on('#rs-from', 'from'); on('#rs-to', 'to'); on('#rs-min', 'min', Number); on('#rs-county', 'county'); on('#rs-range', 'range');
  $('#rs-table').addEventListener('click', e => {
    const sort = e.target.closest('[data-sort]'), tr = e.target.closest('tr[data-id]');
    if (sort) { const key = sort.dataset.sort; if (sortState.key === key) sortState.dir = -sortState.dir; else { sortState.key = key; sortState.dir = key === 'name' ? 1 : -1; } drawTable(cur); }
    else if (tr) setSelection(tr.dataset.id);
  });
  $('#rs-table').addEventListener('pointerover', e => { const tr = e.target.closest('tr[data-id]'); setHover(tr ? tr.dataset.id : null); });
  $('#rs-table').addEventListener('pointerleave', () => setHover(null));
  const county = await ensureStore('county');
  const names = county.ids.map((id, i) => [id, county.labels[i]]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  fillSelect($('#rs-county'), [new Option('All counties', ''), ...names.map(([id, label]) => new Option(label, id))], rs.county);
}

// ---- Public ----
// Levels are offered when their extra file was published; without any, the tab keeps its county-only map.
export async function resultsAvailable() {
  present = await fetch(`${base}data/optional.json`).then(r => r.ok ? r.json() : []).catch(() => []);
  available = levelOrder.filter(l => levelInfo[l].extra && present.includes(levelInfo[l].extra));
  return available.length > 0;
}
export async function activate(on) {
  active = on;
  if (!on) {
    const url = new URL(location.href);
    for (const name of Object.values(urlKeys)) url.searchParams.delete(name);
    history.replaceState(null, '', url);
    return;
  }
  if (!started) {
    started = true;
    readURL();
    await setupControls();
    initMap();
    window.addEventListener('palette-change', () => { if (active && cur) paint(); });
    new MutationObserver(() => { if (active && cur) paint(); }).observe(document.documentElement, { attributes:true, attributeFilter:['data-layout'] });
  }
  map?.resize();
  syncURL();
}
