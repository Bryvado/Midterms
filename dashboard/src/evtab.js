import maplibregl from 'maplibre-gl';
import { scaleLinear } from 'd3-scale';
import { base, csv, pct, probPct, count, escapeHTML } from './data.js';
import { mapBasics } from './map.js';

// Early vote tab. Regions come from the published early_vote_map files (one row per area per day, cumulative);
// statewide totals and the daily chart come from the official early_vote_daily file. Blank cells are suppressed
// (fewer than 5 voters) and are never filled in, derived or used in a calculation.
const files = { precinct:'early_vote_map_precinct.csv', puma:'early_vote_map_puma.csv', county:'early_vote_map_county.csv' };
const projections = { precinct:'regional_projections.csv', puma:'puma_projections.csv', county:'county_projections.csv' };
const levelNames = { precinct:'precincts', puma:'PUMAs', county:'counties' };
const MIN = 5;
const measures = [
  { key:'pace', label:'Pace vs model', kind:'pace', group:'Pace' },
  { key:'pct_registered', label:'% of registered voters', kind:'share', group:'Turnout' },
  { key:'pct_of_2022', label:'% of 2022 turnout', kind:'share', group:'Turnout' },
  { key:'early_ballots', label:'Early ballots', kind:'count', group:'Turnout' },
  { key:'d_share_primary_history', label:'D share of early voters with a primary history', kind:'dshare', group:'Primary-history mix' },
];
// Pace is turnout, not partisanship, so its classes use neutral palettes: five classes behind, five ahead.
const pacePalettes = {
  prgn:{ label:'Purple / green', below:['#762a83', '#9970ab', '#c2a5cf', '#ddc9e3', '#efe6f1'], above:['#e1f3dc', '#b8e1b1', '#7fc27d', '#3f9b50', '#1b7837'] },
  brbg:{ label:'Brown / teal', below:['#8c510a', '#bf812d', '#d8b365', '#ebd9ae', '#f5ecd2'], above:['#d4ece8', '#a6d8d1', '#5ab4ac', '#2b8c88', '#01665e'] },
};
const params = new URLSearchParams(location.search);
const st = {
  level:files[params.get('evl')] ? params.get('evl') : 'county',
  measure:measures.some(m => m.key === params.get('evm')) ? params.get('evm') : 'pace',
  date:params.get('evd') || null,
  spal:params.get('evs') || 'teal', dpal:params.get('evdp') || 'redblue', ppal:pacePalettes[params.get('evpp')] ? params.get('evpp') : 'prgn',
  bars:'lean', sel:null, hover:null,
};
const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
const measureOf = key => measures.find(m => m.key === key) || measures[0];
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : NaN;
const dateText = (d, year = false) => { const t = new Date(`${d}T12:00:00`); return Number.isNaN(+t) ? String(d) : t.toLocaleDateString('en-US', { month:'short', day:'numeric', ...(year ? { year:'numeric' } : {}) }); };
// A blank cell is suppressed, and a published count of 1 to 4 is treated the same way. Zero is a real zero.
const showN = n => !Number.isFinite(n) || (n > 0 && n < MIN) ? 'fewer than 5' : count(n);
const lean = p => !Number.isFinite(p) ? null : p < .4 ? 'paxton' : p > .6 ? 'talarico' : 'tossup';
const leanLabel = { paxton:'Paxton favored', tossup:'Toss-up', talarico:'Talarico favored' };
// Signal reliability from the number of early ballots.
const tierOf = n => !Number.isFinite(n) ? 'suppressed' : n < 50 ? 'low' : n < 250 ? 'medium' : 'high';
const tierLabel = { low:'Low (under 50 early ballots)', medium:'Medium (50 to 249)', high:'High (250 or more)', suppressed:'Suppressed (fewer than 5)' };
const times = v => Number.isFinite(v) ? `${v.toFixed(2)}×` : 'n/a';
// 90% interval for a share from n voters, clipped to [0, 1].
const shareInterval = (p, n) => { const h = 1.645 * Math.sqrt(p * (1 - p) / n); return [Math.max(0, p - h), Math.min(1, p + h)]; };
// 90% interval for pace from the number of early ballots.
const paceInterval = (pace, n) => { const f = Math.exp(1.645 / Math.sqrt(n)); return [pace / f, pace * f]; };
// Primary-history bins in table order, and in bar order (R on the left, none and both in the middle, D on the right).
const binRows = [
  ['r_only_1of4', 'R primary only: 1 of 4', 'r1'], ['r_only_2of4', 'R primary only: 2 of 4', 'r2'], ['r_only_3of4', 'R primary only: 3 of 4', 'r3'], ['r_only_4of4', 'R primary only: 4 of 4', 'r4'],
  ['no_primary', 'No primary history', 'none'], ['both_parties', 'Both parties', 'both'],
  ['d_only_1of4', 'D primary only: 1 of 4', 'd1'], ['d_only_2of4', 'D primary only: 2 of 4', 'd2'], ['d_only_3of4', 'D primary only: 3 of 4', 'd3'], ['d_only_4of4', 'D primary only: 4 of 4', 'd4'],
];
const barOrder = binRows.map(b => b[0]);

const cache = new Map();
function load(level) {
  if (!cache.has(level)) cache.set(level, Promise.all([csv(files[level]), csv(projections[level])]).then(([rows, proj]) => {
    const byDate = new Map(), byId = new Map();
    for (const row of rows) {
      const id = String(row.region_id);
      if (!byDate.has(row.date)) byDate.set(row.date, new Map());
      byDate.get(row.date).set(id, row);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(row);
    }
    for (const list of byId.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    const dates = [...byDate.keys()].sort();
    // Fixed ranges per measure across every date, so moving the slider shows real change.
    const ranges = {};
    for (const m of measures) {
      if (m.kind === 'pace') continue;
      const values = rows.map(row => num(row[m.key])).filter(Number.isFinite).sort((a, b) => a - b);
      if (m.kind === 'dshare') { const d = quantile(values.map(v => Math.abs(v - .5)).sort((a, b) => a - b), .99); ranges[m.key] = [.5 - (d > 0 ? d : .1), .5 + (d > 0 ? d : .1)]; }
      else { const hi = quantile(values, .99); ranges[m.key] = [0, hi > 0 ? hi : 1]; }
    }
    const forecast = new Map(proj.map(row => [String(row.region_id), { label:row.region_label, mean:num(row.mean), p:num(row.p_talarico), confidence:num(row.confidence) }]));
    return { dates, byDate, byId, ranges, forecast };
  }).catch(error => { cache.delete(level); throw error; }));
  return cache.get(level);
}

const $ = selector => document.querySelector(selector);
const tab = $('#ev-tab');
// Fill and boundary display, kept per geography in this browser.
const displayDefaults = { precinct:{ op:90, ln:true, bw:.3, ol:25 }, puma:{ op:90, ln:true, bw:.7, ol:25 }, county:{ op:90, ln:true, bw:.7, ol:25 } };
let display;
try { display = JSON.parse(localStorage.getItem('evt-display-v1') || 'null'); } catch { display = null; }
display = Object.fromEntries(Object.entries(displayDefaults).map(([level, d]) => [level, { ...d, ...(display?.[level] || {}) }]));
const saveDisplay = () => { try { localStorage.setItem('evt-display-v1', JSON.stringify(display)); } catch {} };
const lineColor = d => `rgba(${mapBasics().theme === 'dark' ? '240,247,247' : '40,60,65'},${d.ln ? d.ol / 100 : 0})`;
let data = null, county = null, daily = new Map(), baselines = new Map(), map = null, mapReady = false, timer = null, started = false;
const labelOf = (level, id, d = level === st.level ? data : county) => d?.forecast.get(id)?.label || (level === 'county' ? `County ${id}` : id);
const rowAt = (d, id) => d?.byDate.get(st.date)?.get(id) || null;

// The state's pace on each date: early ballots over expected ballots across the counties that publish early ballots.
// Suppressed counties are left out of both sides. A pace of 1 is the state average in this data.
function baselineFor(date) {
  if (!baselines.has(date)) {
    let early = 0, expected = 0;
    for (const row of (county.byDate.get(date) || new Map()).values()) { const e = num(row.early_ballots), x = num(row.expected_ballots); if (Number.isFinite(e) && Number.isFinite(x)) { early += e; expected += x; } }
    baselines.set(date, expected > 0 ? early / expected : NaN);
  }
  return baselines.get(date);
}
const paceOf = row => num(row?.pct_of_expected) / baselineFor(st.date);

function writeURL() {
  const url = new URL(location.href);
  if (tab.hidden) for (const key of ['tab', 'evl', 'evm', 'evd', 'evs', 'evdp', 'evpp']) url.searchParams.delete(key);
  else Object.entries({ tab:'early', evl:st.level, evm:st.measure, evd:st.date, evs:st.spal, evdp:st.dpal, evpp:st.ppal }).forEach(([k, v]) => v && url.searchParams.set(k, v));
  history.replaceState(null, '', url);
}

// ---- Map ----
const SUPPRESSED = () => mapBasics().theme === 'dark' ? '#5b6670' : '#cfd5d5';
function ramp(diverging) {
  const b = mapBasics(), palettes = diverging ? b.divergingPalettes : b.sequentialPalettes, key = diverging ? st.dpal : st.spal;
  return (palettes[key] || palettes[diverging ? 'redblue' : 'teal'])[b.theme];
}
// Colours are assigned per region in the browser from published values; the tiles carry no early-vote columns.
function colorData() {
  const m = measureOf(st.measure), rows = data.byDate.get(st.date) || new Map(), colors = {}, low = [];
  for (const [id, row] of rows) if (tierOf(num(row.early_ballots)) === 'low') low.push(id);
  if (m.kind === 'pace') {
    const vals = [];
    for (const [id, row] of rows) { const v = paceOf(row); if (Number.isFinite(v)) vals.push([id, v]); }
    const below = vals.map(x => x[1]).filter(v => v < 1).sort((a, b) => a - b), above = vals.map(x => x[1]).filter(v => v >= 1).sort((a, b) => a - b);
    // Equal-count classes: up to five among regions behind the state's pace and five among those ahead.
    const edges = list => Array.from({ length:4 }, (_, i) => quantile(list, (i + 1) / 5));
    const eb = edges(below), ea = edges(above), pal = pacePalettes[st.ppal];
    const classOf = v => v < 1 ? eb.filter(e => v >= e).length : 5 + ea.filter(e => v >= e).length;
    const all = [...pal.below, ...pal.above];
    for (const [id, v] of vals) colors[id] = all[classOf(v)];
    return { m, colors, low, classes:{ palette:all, edges:[below[0], ...eb, 1, ...ea, above.at(-1)] }, baseline:baselineFor(st.date) };
  }
  const diverging = m.kind === 'dshare', [lo, hi] = data.ranges[m.key], b = mapBasics(), type = diverging ? 'share' : 'seq', cols = ramp(diverging);
  const steps = 64, lut = Array.from({ length:steps + 1 }, (_, i) => b.colorAt(cols, i / steps, type));
  for (const [id, row] of rows) { const v = num(row[m.key]); if (Number.isFinite(v)) colors[id] = lut[Math.round(Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * steps)]; }
  return { m, colors, low, range:[lo, hi], diverging, ramp:cols, type };
}
const idFilter = ids => ['in', ['to-string', ['get', 'region_id']], ['literal', ids]];
function hatchImage() {
  const size = 8, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = 'rgba(40,52,58,.7)'; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.moveTo(-2, 2); ctx.lineTo(2, -2); ctx.moveTo(size - 2, size + 2); ctx.lineTo(size + 2, size - 2); ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}
function addLayers() {
  const b = mapBasics(), layers = map.getStyle().layers;
  let start = layers.length;
  while (start > 0 && layers[start - 1].type === 'symbol') start--;
  const before = layers[start]?.id;
  if (!map.hasImage('evt-hatch')) map.addImage('evt-hatch', hatchImage());
  for (const level of Object.keys(files)) {
    if (!map.getSource(level)) map.addSource(level, { type:'vector', url:b.tileURL(b.tiles[level]), promoteId:'region_id' });
    const vis = level === st.level ? 'visible' : 'none';
    map.addLayer({ id:`evt-fill-${level}`, type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:vis }, paint:{ 'fill-color':SUPPRESSED(), 'fill-opacity':display[level].op / 100 } }, before);
    map.addLayer({ id:`evt-hatch-${level}`, type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:vis }, filter:idFilter([]), paint:{ 'fill-pattern':'evt-hatch', 'fill-opacity':.55 } }, before);
    map.addLayer({ id:`evt-line-${level}`, type:'line', source:level, 'source-layer':'regions', layout:{ visibility:vis }, paint:{ 'line-color':lineColor(display[level]), 'line-width':display[level].bw } }, before);
    map.addLayer({ id:`evt-hi-${level}`, type:'line', source:level, 'source-layer':'regions', layout:{ visibility:vis }, filter:idFilter([]), paint:{ 'line-color':b.theme === 'dark' ? '#ffffff' : '#111a1f', 'line-width':2.6 } }, before);
  }
  // The county table can highlight a county at any geography.
  map.addLayer({ id:'evt-hi-countytable', type:'line', source:'county', 'source-layer':'regions', filter:idFilter([]), paint:{ 'line-color':'#c98a00', 'line-width':2.4, 'line-dasharray':[2, 1] } }, before);
  b.labels(map);
  mapReady = true;
  paintMap();
}
function paintDisplay() {
  if (!mapReady) return;
  const d = display[st.level];
  map.setPaintProperty(`evt-fill-${st.level}`, 'fill-opacity', d.op / 100);
  map.setPaintProperty(`evt-line-${st.level}`, 'line-color', lineColor(d));
  map.setPaintProperty(`evt-line-${st.level}`, 'line-width', d.bw);
}
function syncDisplay() {
  const d = display[st.level];
  $('#evt-op').value = d.op; $('#evt-op-v').textContent = `${d.op}%`;
  $('#evt-ln').checked = d.ln;
  $('#evt-bw').value = d.bw; $('#evt-bw-v').textContent = `${(+d.bw).toFixed(1)} px`;
  $('#evt-ol').value = d.ol; $('#evt-ol-v').textContent = `${d.ol}%`;
  $('#evt-bw').disabled = $('#evt-ol').disabled = !d.ln;
}
function paintMap() {
  if (!mapReady || !data) return;
  const d = colorData();
  for (const level of Object.keys(files)) for (const kind of ['fill', 'hatch', 'line', 'hi']) map.setLayoutProperty(`evt-${kind}-${level}`, 'visibility', level === st.level ? 'visible' : 'none');
  // Regions without a colour (suppressed, or without a value for this measure) fall back to a flat grey.
  map.setPaintProperty(`evt-fill-${st.level}`, 'fill-color', ['coalesce', ['get', ['to-string', ['get', 'region_id']], ['literal', d.colors]], SUPPRESSED()]);
  paintDisplay();
  map.setFilter(`evt-hatch-${st.level}`, idFilter(d.low));
  paintHighlight();
  drawLegend(d);
}
function paintHighlight() {
  if (!mapReady) return;
  const ids = [st.hover, st.sel].filter(x => x && x.level === st.level).map(x => x.id);
  map.setFilter(`evt-hi-${st.level}`, idFilter(ids));
  const counties = [st.hover, st.sel].filter(x => x && x.level === 'county' && st.level !== 'county').map(x => x.id);
  map.setFilter('evt-hi-countytable', idFilter(counties));
}
function drawLegend(d) {
  const fmt = v => d.m.kind === 'count' ? count(v) : pct(v);
  let body, note;
  if (d.m.kind === 'pace') {
    const { palette, edges } = d.classes, sw = palette.map(c => `<span style="background:${c}"></span>`).join(''), at = i => `${(10 * i)}%`;
    body = `<div class="legend-steps">${sw}</div><div class="legend-edges">${[2, 5, 8].map(i => `<span style="left:${at(i)}">${Number.isFinite(edges[i]) ? edges[i].toFixed(2) : ''}</span>`).join('')}</div>
      <div class="legend-ends"><span>Behind the state</span><span>Ahead of the state</span></div>`;
    note = `1.00 is the state's pace on this date: ${pct(d.baseline)} of the model's expected ballots cast, across published areas. Five classes of equal count behind pace and five ahead.`;
  } else {
    const [lo, hi] = d.range, gradient = Array.from({ length:9 }, (_, i) => `${mapBasics().colorAt(d.ramp, i / 8, d.type)} ${(100 * i / 8).toFixed(1)}%`).join(',');
    body = `<div class="legend-ramp" style="background:linear-gradient(90deg,${gradient})"></div>
      <div class="legend-edges"><span style="left:0.00%">${escapeHTML(fmt(lo))}</span><span style="left:50%">${escapeHTML(fmt((lo + hi) / 2))}</span><span style="left:100.00%">${escapeHTML(fmt(hi))}${d.diverging ? '' : '+'}</span></div>
      ${d.diverging ? '<div class="legend-ends"><span>More Republican</span><span>More Democratic</span></div>' : ''}`;
    note = d.diverging ? 'Centered on 50%; the range is symmetric and fixed across dates.' : 'Range fixed across dates; values above it saturate.';
  }
  $('#evt-legend').innerHTML = `<div class="legend-title">${escapeHTML(d.m.label)}, through ${escapeHTML(dateText(st.date))}</div>${body}
    <div class="legend-nodata"><span style="background:${SUPPRESSED()}"></span>${d.m.kind === 'dshare' ? 'Fewer than 5 with a primary history, or fewer than 5 early voters' : 'Fewer than 5 early voters'}</div>
    <div class="legend-nodata"><span class="evt-hatch-swatch"></span>Low signal reliability: under 50 early ballots</div>
    <div class="legend-note">${escapeHTML(note)}</div>`;
}

// ---- Tooltip and detail blocks ----
function primaryBlock(row) {
  const early = num(row.early_ballots);
  if (!binRows.some(([key]) => Number.isFinite(num(row[key])))) return '';
  const cell = ([key, label, cls]) => {
    const n = num(row[key]), ok = Number.isFinite(n) && !(n > 0 && n < MIN);
    return `<tr><td><i class="evt-chip b-${cls}"></i>${escapeHTML(label)}</td><td>${ok ? count(n) : 'fewer than 5'}</td><td>${ok && early > 0 ? pct(n / early, 1) : ''}</td></tr>`;
  };
  const segs = barOrder.map(key => { const n = num(row[key]), cls = binRows.find(b => b[0] === key)[2]; return Number.isFinite(n) && n >= MIN && early > 0 ? `<span class="b-${cls}" style="width:${(100 * n / early).toFixed(2)}%" title="${escapeHTML(binRows.find(b => b[0] === key)[1])}"></span>` : ''; }).join('');
  const hidden = binRows.some(([key]) => { const n = num(row[key]); return !Number.isFinite(n) || (n > 0 && n < MIN); });
  return `<div class="evt-primary"><div class="evt-stack">${segs}</div><div class="evt-stack-ends"><span>R</span><span>none · both</span><span>D</span></div>
    <table class="evt-bins"><tbody>${binRows.map(cell).join('')}</tbody></table>${hidden ? '<div class="evt-fine">Cells under 5 voters are not shown or drawn.</div>' : ''}</div>`;
}
function forecastBlock(f) {
  if (!f || !Number.isFinite(f.mean)) return '';
  return `<div class="evt-forecast"><div class="evt-fhead">Model forecast, not an early-vote result</div>Talarico ${pct(f.mean)} · win probability ${probPct(f.p)} · confidence ${probPct(f.confidence)} · ${escapeHTML(leanLabel[lean(f.p)] || '')}</div>`;
}
function tooltipHTML(level, id) {
  const d = level === st.level ? data : county, row = rowAt(d, id), f = d?.forecast.get(id);
  const head = `<strong>${escapeHTML(labelOf(level, id, d))}</strong>Through ${escapeHTML(dateText(st.date))}<br>`;
  if (!row) return `${head}No early-vote record for this area.`;
  const v = key => num(row[key]), tier = tierOf(v('early_ballots'));
  if (tier === 'suppressed') return `${head}Fewer than 5 early voters.<br>Expected ballots: ${count(v('expected_ballots'))}${forecastBlock(f)}`;
  const pace = paceOf(row), ds = v('d_share_primary_history'), n = v('with_primary_history');
  return head + [
    `Early ballots: ${showN(v('early_ballots'))} (${showN(v('in_person'))} in person / ${showN(v('mail'))} mail)`,
    `Expected ballots: ${count(v('expected_ballots'))} · pace ${times(pace)} the state's (${pct(v('pct_of_expected'))} of expected)`,
    `% of registered: ${pct(v('pct_registered'))} · % of 2022: ${pct(v('pct_of_2022'))}`,
    `Signal reliability: ${tierLabel[tier]}`,
  ].map(escapeHTML).join('<br>') + primaryBlock(row)
    + (Number.isFinite(ds) && Number.isFinite(n) ? `<div>${escapeHTML(`D share with a primary history: ${pct(ds)} of ${showN(n)}`)}</div>` : '<div>D share: fewer than 5 with a primary history</div>')
    + forecastBlock(f);
}
// The map is created while the tab can still be laying out, so it follows its container: whenever the box changes from empty
// to a real size, or resizes, it resizes the canvas and, the first time it has a size, refits to Texas.
let fitted = false;
function watchMapSize() {
  const wrap = $('.evt-map-wrap');
  const fit = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!map || !w || !h) return;
    map.resize();
    if (!fitted) { fitted = true; map.fitBounds(mapBasics().bounds, { padding:24, duration:0 }); }
  };
  new ResizeObserver(fit).observe(wrap);
  new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) fit(); }).observe(wrap);
  fit();
}
function initMap() {
  const b = mapBasics();
  map = new maplibregl.Map({ container:'evt-map', style:b.style, bounds:b.bounds, fitBoundsOptions:{ padding:24 }, attributionControl:false, cooperativeGestures:true });
  watchMapSize();
  map.addControl(new maplibregl.AttributionControl({ compact:true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'top-right');
  map.on('style.load', addLayers);
  const tip = $('#evt-tooltip');
  map.on('mousemove', e => {
    if (!mapReady) return;
    const f = map.queryRenderedFeatures(e.point, { layers:[`evt-fill-${st.level}`] })[0];
    map.getCanvas().style.cursor = f ? 'pointer' : '';
    if (!f) { tip.hidden = true; setHover(null); return; }
    const id = String(f.properties.region_id);
    tip.innerHTML = tooltipHTML(st.level, id); tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight, box = map.getContainer().getBoundingClientRect();
    tip.style.left = `${e.point.x + 14 + w > box.width ? Math.max(4, e.point.x - w - 14) : e.point.x + 14}px`;
    tip.style.top = `${Math.max(6, Math.min(box.height - h - 6, e.point.y - h / 2))}px`;
    setHover({ level:st.level, id });
  });
  map.on('mouseout', () => { tip.hidden = true; setHover(null); });
  map.on('click', e => {
    const f = mapReady && map.queryRenderedFeatures(e.point, { layers:[`evt-fill-${st.level}`] })[0];
    setSelection(f ? { level:st.level, id:String(f.properties.region_id) } : null);
  });
}
window.addEventListener('display-change', () => {
  if (!map) return;
  const b = mapBasics();
  if (map._evtStyle !== b.style) { map._evtStyle = b.style; mapReady = false; map.setStyle(b.style); }
});

// ---- Linked highlighting: hover and selection move rings on every chart without redrawing the points ----
const focusPos = { pace:new Map(), dshare:new Map() };
function drawFocus() {
  const ids = [st.sel, st.hover].filter(x => x && x.level === st.level).map(x => x.id);
  for (const [name, host] of [['pace', '#evt-pace-scatter'], ['dshare', '#evt-scatter']]) {
    const g = document.querySelector(`${host} .evt-focus`);
    if (g) g.innerHTML = ids.map(id => focusPos[name].get(id)).filter(Boolean).map(p => `${p.lo != null ? `<line class="evt-ci" x1="${p.x}" x2="${p.x}" y1="${p.lo}" y2="${p.hi}"/>` : ''}<circle class="evt-ring" cx="${p.x}" cy="${p.y}" r="${p.r + 4}"/>`).join('');
  }
  const set = new Set(ids);
  for (const el of document.querySelectorAll('#evt-rank [data-id]')) el.classList.toggle('active', set.has(el.dataset.id));
}
function setHover(next) {
  if (st.hover?.id === next?.id && st.hover?.level === next?.level) return;
  st.hover = next;
  paintHighlight(); drawFocus(); markTable();
}
function setSelection(next) {
  st.sel = next;
  paintHighlight(); drawFocus(); markTable(); drawCard(); drawTrend();
}

// ---- Summary: the official state count for the selected date ----
function drawSummary() {
  const row = daily.get(st.date);
  const cell = (label, value, sub = '') => `<div class="evt-stat"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong>${sub ? `<em>${escapeHTML(sub)}</em>` : ''}</div>`;
  const rows = [...(county.byDate.get(st.date) || new Map()).values()];
  const primary = rows.filter(r => Number.isFinite(num(r.with_primary_history)) && Number.isFinite(num(r.d_primary)));
  const n = primary.reduce((t, r) => t + num(r.with_primary_history), 0), dCount = primary.reduce((t, r) => t + num(r.d_primary), 0);
  const share = n > 0 ? dCount / n : NaN;
  const withheld = rows.filter(r => !Number.isFinite(num(r.early_ballots))).length;
  const none = 'official count starts Oct 19';
  const o = key => row ? num(row[key]) : NaN;
  $('#evt-summary').innerHTML = cell('Early ballots, official count', row ? count(o('total_early')) : '—', row ? `through ${dateText(st.date, true)}, ${count(o('counties_reporting'))} counties reporting` : none)
    + cell('In person · mail, official count', row ? `${count(o('in_person'))} · ${count(o('mail'))}` : '—', row && o('total_early') > 0 ? `${pct(o('in_person') / o('total_early'), 0)} in person` : '')
    + cell('% of registered, official count', row ? pct(o('pct_registered')) : '—', row ? `${count(o('registered'))} registered` : '')
    + cell('% of 2022 turnout, official count', row ? pct(o('pct_of_2022_total')) : '—', row ? `${count(o('turnout_2022'))} voted in 2022` : '')
    + cell('% of expected ballots, official count', row ? pct(o('pct_of_expected')) : '—', row ? `${count(o('expected_ballots'))} expected. Pace uses roster ballots: ${pct(baselineFor(st.date))}` : '')
    + cell('D share, primary history, rosters', pct(share), `published counties${withheld ? `, ${withheld} withheld` : ''}`);
}

// ---- Cumulative chart: the official statewide count, or the selected area from the map file ----
function drawTrend() {
  const host = $('#evt-trend'), width = Math.max(260, host.clientWidth || 360), height = 200, m = { top:12, right:12, bottom:24, left:44 };
  const target = st.sel ? (st.sel.level === st.level ? data : county) : null;
  let series, all, expected = NaN;
  if (st.sel && target) {
    const list = target.byId.get(st.sel.id) || [];
    series = list.map(row => ({ date:row.date, person:num(row.in_person), mail:num(row.mail), total:num(row.early_ballots) }));
    expected = num(list.at(-1)?.expected_ballots);
    all = county.dates;
    $('#evt-trend-sub').textContent = labelOf(st.sel.level, st.sel.id, target);
  } else {
    series = [...daily.values()].map(r => ({ date:r.date, person:num(r.in_person), mail:num(r.mail), total:num(r.total_early) }));
    expected = num([...daily.values()].at(-1)?.expected_ballots);
    all = [...new Set([...county.dates, ...daily.keys()])].sort();
    $('#evt-trend-sub').textContent = 'Statewide, official count';
  }
  // The published total drives the chart. The in-person split is drawn only on dates where both subtype counts are published.
  const rows = series.filter(r => r.total >= MIN);
  const split = r => Number.isFinite(r.person) && Number.isFinite(r.mail) && !(r.person > 0 && r.person < MIN) && !(r.mail > 0 && r.mail < MIN);
  if (!rows.length) { host.innerHTML = '<p class="note">Fewer than 5 early voters on every date, so nothing is shown.</p>'; return; }
  const x = d => m.left + (all.length === 1 ? 0 : all.indexOf(d) / (all.length - 1)) * (width - m.left - m.right);
  const top = Math.max(...rows.map(r => r.total), Number.isFinite(expected) ? expected : 0) * 1.12, y = v => height - m.bottom - v / top * (height - m.top - m.bottom);
  const area = (list, hi) => `M${list.map(r => `${x(r.date).toFixed(1)},${y(hi(r)).toFixed(1)}`).join('L')}L${[...list].reverse().map(r => `${x(r.date).toFixed(1)},${y(0).toFixed(1)}`).join('L')}Z`;
  const runs = [];
  for (const r of rows) { if (!split(r)) { runs.push(null); continue; } if (runs.at(-1)) runs.at(-1).push(r); else runs.push([r]); }
  const personAreas = runs.filter(run => run && run.length > 1).map(run => `<path class="evt-area person" d="${area(run, r => r.person)}"/>`).join('');
  const short = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v));
  const ticks = scaleLinear().domain([0, top]).ticks(4);
  // About five date ticks; the last date always shows, and a tick that would crowd its neighbour is skipped.
  const step = Math.max(1, Math.ceil((all.length - 1) / 4)), picks = [], gap = 40;
  for (let i = 0; i < all.length; i += step) picks.push(i);
  if (picks.at(-1) !== all.length - 1) { if (x(all.at(-1)) - x(all[picks.at(-1)]) < gap) picks.pop(); picks.push(all.length - 1); }
  // The expected-ballots line is labelled in place, inside the plot, so the text can never run past the edge.
  const ey = Number.isFinite(expected) ? Math.max(m.top + 10, y(expected) - 4) : 0;
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cumulative early ballots by date">
    ${ticks.map(v => `<line class="evt-grid" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/><text class="evt-axis" x="${m.left - 5}" y="${y(v) + 3}" text-anchor="end">${short(v)}</text>`).join('')}
    <path class="evt-area mail" d="${area(rows, r => r.total)}"/>${personAreas}
    ${Number.isFinite(expected) ? `<line class="evt-expected" x1="${m.left}" x2="${width - m.right}" y1="${y(expected)}" y2="${y(expected)}"/><text class="evt-axis evt-expected-label" x="${width - m.right - 2}" y="${ey}" text-anchor="end">Expected ${short(expected)}</text>` : ''}
    <line class="evt-now" x1="${x(st.date)}" x2="${x(st.date)}" y1="${m.top}" y2="${height - m.bottom}"/>
    ${picks.map(i => `<text class="evt-axis" x="${x(all[i])}" y="${height - 7}" text-anchor="${i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}">${escapeHTML(dateText(all[i]))}</text>`).join('')}
    ${all.filter(d => county.dates.includes(d)).map(d => `<rect class="evt-hit" data-date="${d}" x="${x(d) - 12}" y="${m.top}" width="24" height="${height - m.top - m.bottom}"/>`).join('')}
  </svg><div class="evt-keys"><span><i class="evt-key person"></i>In person</span><span><i class="evt-key mail"></i>All early ballots</span></div>`;
}

// ---- Scatter charts: a binned density grid by default, or capped points ----
const POINT_CAP = 1500, GRID = 40;
const scatterMode = { pace:'binned', dshare:'binned' };
let scatterHits = { pace:[], dshare:[] };
// Forecast lean as a continuous colour: Paxton red through grey to Talarico blue, by win probability.
const leanColor = scaleLinear().domain([0, .5, 1]).range(['#b2453c', '#9aa5a8', '#1d6483']).clamp(true);
const pickFrom = (name, host, event) => {
  const hits = scatterHits[name], svg = document.querySelector(`${host} svg`);
  if (!svg || !hits.length) return null;
  const box = svg.getBoundingClientRect(), k = svg.viewBox.baseVal.width / box.width, mx = (event.clientX - box.left) * k, my = (event.clientY - box.top) * k;
  if (hits[0].bin) { const cell = hits.find(c => mx >= c.x0 && mx < c.x1 && my >= c.y1 && my < c.y0); return cell ? { ...cell, scale:k } : null; }
  let best = null, bestD = 64;
  for (const p of hits) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bestD) { bestD = d; best = p; } }
  return best ? { ...best, scale:k } : null;
};
function mountSvg(host, svg) {
  const tip = host.querySelector('.chart-tooltip');
  host.innerHTML = svg; host.append(tip);
}
// One drawing routine for both scatters. The x axis is the forecast Talarico share; c says what the y axis is.
function drawScatterPanel(c) {
  const host = $(c.host), width = Math.max(260, host.clientWidth || 360), height = 250, m = { top:6, right:6, bottom:30, left:40 }, pad = 8;
  const rows = data.byDate.get(st.date) || new Map(), all = [];
  for (const [id, row] of rows) {
    const f = data.forecast.get(id), x = f?.mean, y = c.y(row);
    if (Number.isFinite(x) && Number.isFinite(y)) all.push({ id, x, y, p:f.p, e:num(row.expected_ballots), n:num(row.early_ballots), row });
  }
  const X0 = m.left + pad, X1 = width - m.right - pad, Y0 = height - m.bottom - pad, Y1 = m.top + pad;
  const sx = v => X0 + Math.max(0, Math.min(1, v)) * (X1 - X0), sy = v => Y0 - c.pos(v) * (Y0 - Y1);
  focusPos[c.name] = new Map(all.map(p => [p.id, { x:+sx(p.x).toFixed(1), y:+sy(p.y).toFixed(1), r:3, ...(c.band ? c.band(p, sy) : {}) }]));
  let marks = '';
  if (scatterMode[c.name] === 'binned') {
    const cells = new Map();
    for (const p of all) {
      const i = Math.min(GRID - 1, Math.floor(Math.max(0, Math.min(1, p.x)) * GRID)), j = Math.min(GRID - 1, Math.floor(c.pos(p.y) * GRID)), key = i * GRID + j;
      const cell = cells.get(key) || { i, j, n:0, pSum:0, pN:0, ySum:0 };
      cell.n++; cell.ySum += p.y; if (Number.isFinite(p.p)) { cell.pSum += p.p; cell.pN++; }
      cells.set(key, cell);
    }
    const maxN = Math.max(1, ...[...cells.values()].map(cell => cell.n)), cw = (X1 - X0) / GRID, ch = (Y0 - Y1) / GRID;
    scatterHits[c.name] = [...cells.values()].map(cell => ({ bin:true, x0:X0 + cell.i * cw, x1:X0 + (cell.i + 1) * cw, y0:Y0 - cell.j * ch, y1:Y0 - (cell.j + 1) * ch, n:cell.n, my:cell.ySum / cell.n, mp:cell.pN ? cell.pSum / cell.pN : NaN, x:X0 + (cell.i + .5) * cw, y:Y0 - (cell.j + .5) * ch }));
    marks = scatterHits[c.name].map(b => `<rect x="${b.x0.toFixed(1)}" y="${b.y1.toFixed(1)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}" fill="${Number.isFinite(b.mp) ? leanColor(b.mp) : '#9aa5a8'}" fill-opacity="${(.18 + .82 * Math.sqrt(b.n / maxN)).toFixed(2)}"/>`).join('');
  } else {
    const pts = all.filter(p => p.n >= 50).sort((a, b) => b.e - a.e).slice(0, POINT_CAP);
    scatterHits[c.name] = pts.map(p => ({ id:p.id, x:sx(p.x), y:sy(p.y) }));
    marks = pts.reverse().map(p => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${leanColor(p.p)}" fill-opacity=".5"/>`).join('');
  }
  mountSvg(host, `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(c.aria)}">
    <rect class="evt-plot" x="${m.left}" y="${m.top}" width="${width - m.left - m.right}" height="${height - m.top - m.bottom}"/>
    ${[0, .5, 1].map(t => `<line class="evt-grid" x1="${sx(t)}" x2="${sx(t)}" y1="${m.top}" y2="${height - m.bottom}"/><text class="evt-axis" x="${sx(t)}" y="${height - m.bottom + 12}" text-anchor="middle">${t * 100}%</text>`).join('')}
    ${c.ticks.map(t => `<line class="evt-grid" x1="${m.left}" x2="${width - m.right}" y1="${sy(t)}" y2="${sy(t)}"/><text class="evt-axis" x="${m.left - 5}" y="${sy(t) + 3}" text-anchor="end">${c.fmt(t)}</text>`).join('')}
    <line class="evt-mid" x1="${m.left}" x2="${width - m.right}" y1="${sy(c.ref)}" y2="${sy(c.ref)}"/>
    ${marks}<g class="evt-focus"></g>
    <text class="evt-axis label" x="${(m.left + width - m.right) / 2}" y="${height - 4}" text-anchor="middle">Forecast Talarico share</text>
    <text class="evt-axis label" transform="translate(11 ${(m.top + height - m.bottom) / 2}) rotate(-90)" text-anchor="middle">${escapeHTML(c.yLabel)}</text></svg>`);
  const binned = scatterMode[c.name] === 'binned', shown = binned ? all.length : scatterHits[c.name].length;
  $(c.caption).textContent = binned ? `${all.length.toLocaleString('en-US')} ${levelNames[st.level]}, binned` : `${shown.toLocaleString('en-US')} of ${all.length.toLocaleString('en-US')} ${levelNames[st.level]} drawn`;
  $(c.pop).innerHTML = `<p>${escapeHTML(c.about)}</p><p><strong>Binned</strong> (default): the plot is split into a ${GRID} × ${GRID} grid. Each cell's colour is the mean forecast win probability of the ${levelNames[st.level]} in it, from Paxton red through grey to Talarico blue, and its opacity grows with how many there are.</p><p><strong>Points</strong>: at most ${POINT_CAP.toLocaleString('en-US')} ${levelNames[st.level]} with the most expected ballots, leaving out any with fewer than 50 early ballots, coloured the same way.</p><p>The line marks ${escapeHTML(c.refText)}.</p>`;
  for (const b of document.querySelectorAll(`[data-scatter-mode="${c.name}"]`)) b.setAttribute('aria-pressed', String(b.dataset.mode === scatterMode[c.name]));
  drawFocus();
}
const paceRange = [Math.log(.4), Math.log(2.5)];
function drawPaceScatter() {
  drawScatterPanel({ name:'pace', host:'#evt-pace-scatter', caption:'#evt-pace-note', pop:'#evt-pop-pace', aria:'Pace against forecast Talarico share',
    y:row => { const v = paceOf(row); return v > 0 ? v : NaN; },
    pos:v => (Math.log(Math.max(.4, Math.min(2.5, v))) - paceRange[0]) / (paceRange[1] - paceRange[0]),
    ticks:[.5, 1, 2], fmt:t => `${t}×`, ref:1, refText:'the state’s pace (1×)', yLabel:'Pace vs the state (log)',
    about:'Each area’s pace (its share of expected ballots cast, relative to the state) against the model’s forecast Talarico share. Pace beyond 0.4× or 2.5× sits on the edge.' });
}
function drawScatter() {
  drawScatterPanel({ name:'dshare', host:'#evt-scatter', caption:'#evt-scatter-note', pop:'#evt-pop-dshare', aria:'D share of early voters with a primary history against forecast Talarico share',
    y:row => num(row.d_share_primary_history), pos:v => Math.max(0, Math.min(1, v)),
    ticks:[0, .5, 1], fmt:t => `${t * 100}%`, ref:.5, refText:'a 50% D share',
    band:(p, sy) => { const n = num(p.row.with_primary_history); if (!Number.isFinite(n)) return {}; const [lo, hi] = shareInterval(p.y, n); return { lo:+sy(lo).toFixed(1), hi:+sy(hi).toFixed(1) }; },
    yLabel:'D share, primary history',
    about:'The Democratic share among early voters who cast a ballot in a 2020–2026 primary, against the model’s forecast Talarico share. A highlighted area shows its 90% interval.' });
}

// ---- Pace by forecast: is early turnout running ahead where Talarico or Paxton is favored? ----
function drawBars() {
  const host = $('#evt-bars'), width = Math.max(260, host.clientWidth || 360), rowH = st.bars === 'lean' ? 34 : 19, m = { top:6, right:48, bottom:20, left:st.bars === 'lean' ? 100 : 58 };
  const rows = data.byDate.get(st.date) || new Map(), base = baselineFor(st.date);
  const groups = st.bars === 'lean'
    ? [['paxton', 'Paxton favored'], ['tossup', 'Toss-up'], ['talarico', 'Talarico favored']].map(([key, label]) => ({ key, label, early:0, expected:0, n:0 }))
    : Array.from({ length:10 }, (_, i) => ({ key:String(i), label:`${i * 10}–${i * 10 + 10}%`, early:0, expected:0, n:0 }));
  for (const [id, row] of rows) {
    const e = num(row.early_ballots), x = num(row.expected_ballots), f = data.forecast.get(id);
    if (!Number.isFinite(e) || !Number.isFinite(x) || !f) continue;
    const g = st.bars === 'lean' ? groups.find(g => g.key === lean(f.p)) : Number.isFinite(f.mean) ? groups[Math.min(9, Math.max(0, Math.floor(f.mean * 10)))] : null;
    if (g) { g.early += e; g.expected += x; g.n++; }
  }
  const use = groups.filter(g => g.expected > 0).map(g => ({ ...g, pace:g.early / g.expected / base }));
  const height = m.top + m.bottom + use.length * rowH;
  const lo = Math.min(.6, ...use.map(g => g.pace)), hi = Math.max(1.4, ...use.map(g => g.pace)), x = v => m.left + (v - lo) / (hi - lo) * (width - m.left - m.right);
  host.innerHTML = use.length ? `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Expected-ballot-weighted pace by forecast">
    ${use.map((g, i) => { const y = m.top + i * rowH; return `<text class="evt-axis" x="${m.left - 6}" y="${y + rowH / 2 + 3}" text-anchor="end">${escapeHTML(g.label)}</text>
      <rect class="evt-bar ${g.pace >= 1 ? 'ahead' : 'behind'}" x="${Math.min(x(1), x(g.pace))}" y="${y + 3}" width="${Math.max(1, Math.abs(x(g.pace) - x(1)))}" height="${rowH - 6}"/>
      <text class="evt-axis" x="${width - m.right + 6}" y="${y + rowH / 2 + 3}">${times(g.pace)}</text>
      <title>${escapeHTML(`${g.label}: ${times(g.pace)} the state's pace across ${g.n.toLocaleString('en-US')} ${levelNames[st.level]}`)}</title>`; }).join('')}
    <line class="evt-now" x1="${x(1)}" x2="${x(1)}" y1="${m.top}" y2="${height - m.bottom}"/>
    <text class="evt-axis" x="${x(1)}" y="${height - 6}" text-anchor="middle">1.00×</text></svg>` : '<p class="note">No areas with published early ballots on this date.</p>';
  $('#evt-pop-bars').innerHTML = `<p>Expected-ballot-weighted pace: early ballots over expected ballots across the published ${levelNames[st.level]} in each group, relative to the state. 1.00× is the state's pace.</p><p>${st.bars === 'lean' ? 'Lean uses the model win probability: Paxton favored below 40%, toss-up 40 to 60%, Talarico favored above 60%.' : 'Bins are the forecast Talarico two-party share in 10-point steps.'}</p>`;
  for (const b of document.querySelectorAll('[data-bars]')) b.setAttribute('aria-pressed', String(b.dataset.bars === st.bars));
}

// ---- Ranked list: furthest ahead and furthest behind among high-reliability areas ----
// The favored candidate and their win probability, for example "Talarico 99%".
const favored = f => !f || !Number.isFinite(f.p) ? 'n/a' : f.p === .5 ? 'even' : f.p > .5 ? `Talarico ${probPct(f.p)}` : `Paxton ${probPct(1 - f.p)}`;
let rankAll = false;
// "County name, VTD 0001" for precincts; other levels keep their published label.
function placeLabel(level, id) {
  const label = labelOf(level, id);
  const m = /^County (\d{3}), VTD (\S+)/.exec(label);
  return m ? `${(county.forecast.get(m[1])?.label || `County ${m[1]}`).replace(/ County$/, '')}, VTD ${m[2]}` : label;
}
function drawRank() {
  const host = $('#evt-rank'), rows = data.byDate.get(st.date) || new Map(), list = [], take = rankAll ? 15 : 6;
  for (const [id, row] of rows) { const e = num(row.early_ballots), p = paceOf(row); if (tierOf(e) === 'high' && Number.isFinite(p) && p > 0) list.push({ id, p, e, ci:paceInterval(p, e) }); }
  list.sort((a, b) => b.p - a.p);
  const ahead = list.filter(a => a.p >= 1).slice(0, take), behind = list.filter(a => a.p < 1).slice(-take).reverse();
  if (!list.length) { host.innerHTML = '<p class="note">No areas have 250 or more early ballots on this date.</p>'; return; }
  const row = a => {
    const f = data.forecast.get(a.id), name = placeLabel(st.level, a.id);
    const tip = `${name}: pace ${times(a.p)} (90% interval ${times(a.ci[0])} to ${times(a.ci[1])}); ${showN(a.e)} early ballots; forecast ${favored(f)}`;
    return `<li class="evt-rank-row" data-id="${escapeHTML(a.id)}" title="${escapeHTML(tip)}"><i class="evt-lean ${lean(f?.p) || 'none'}" aria-label="${escapeHTML(leanLabel[lean(f?.p)] || 'no forecast')}"></i><span class="evt-rank-name">${escapeHTML(name)}</span><span class="evt-rank-pace">${times(a.p)}</span></li>`;
  };
  host.innerHTML = `${ahead.length ? `<h4>Furthest ahead</h4><ol>${ahead.map(row).join('')}</ol>` : ''}${behind.length ? `<h4>Furthest behind</h4><ol>${behind.map(row).join('')}</ol>` : ''}`;
  const more = $('#evt-rank-more');
  more.hidden = list.filter(a => a.p >= 1).length <= 6 && list.filter(a => a.p < 1).length <= 6;
  more.textContent = rankAll ? 'Show 6' : 'Show 15';
  $('#evt-pop-rank').innerHTML = `<p>High-reliability ${levelNames[st.level]} only (250 or more early ballots), ranked by pace against the state. The dot is the model's forecast lean, not an early-vote result. Hover a row for its 90% pace interval and forecast.</p>`;
  drawFocus();
}

// ---- County table ----
const tableState = { sort:'early_ballots', dir:-1 };
const columns = [
  { key:'name', label:'County', text:true },
  { key:'expected_ballots', label:'Expected ballots', type:'plain' },
  { key:'early_ballots', label:'Early ballots', type:'count' }, { key:'in_person', label:'In person', type:'count' }, { key:'mail', label:'Mail', type:'count' },
  { key:'pct_registered', label:'% registered', type:'share' }, { key:'pct_of_2022', label:'% of 2022', type:'share' }, { key:'pct_of_expected', label:'% of expected', type:'share' },
  { key:'pace', label:'Pace', type:'pace' }, { key:'tier', label:'Signal', text:true },
  { key:'d_share_primary_history', label:'D share, primary history', type:'dshare' },
  { key:'forecast', label:'Forecast share', type:'share' }, { key:'p', label:'Win probability', type:'share' }, { key:'confidence', label:'Forecast confidence', type:'share' },
];
function tableRows() {
  return [...(county.byDate.get(st.date) || new Map())].map(([id, row]) => {
    const f = county.forecast.get(id);
    return { id, row, name:labelOf('county', id, county), forecast:f?.mean, p:f?.p, confidence:f?.confidence, pace:paceOf(row), tier:tierLabel[tierOf(num(row.early_ballots))].split(' (')[0] };
  });
}
const cellValue = (r, c) => ['name', 'tier', 'forecast', 'p', 'confidence', 'pace'].includes(c.key) ? r[c.key] : num(r.row[c.key]);
function drawTable() {
  const col = columns.find(c => c.key === tableState.sort) || columns[2];
  const rows = tableRows().sort((a, b) => { const p = cellValue(a, col), q = cellValue(b, col); return (col.text ? String(p).localeCompare(String(q)) : (Number.isFinite(p) ? p : -Infinity) - (Number.isFinite(q) ? q : -Infinity)) * tableState.dir; });
  const show = (r, c) => {
    const v = cellValue(r, c);
    if (c.text) return escapeHTML(v);
    if (c.type === 'plain') return count(v);
    if (c.type === 'count') return Number.isFinite(num(r.row.early_ballots)) ? showN(v) : 'fewer than 5';
    if (c.type === 'pace') return Number.isFinite(v) ? times(v) : 'fewer than 5';
    if (c.type === 'dshare') { const n = num(r.row.with_primary_history); if (!Number.isFinite(v) || !Number.isFinite(n)) return '<span class="muted">fewer than 5</span>'; const [lo, hi] = shareInterval(v, n); return `${pct(v)} <span class="muted">(${pct(lo)}–${pct(hi)})</span>`; }
    return Number.isFinite(v) ? (c.key === 'p' || c.key === 'confidence' ? probPct(v) : pct(v, 1)) : c.key === 'forecast' || c.key === 'p' || c.key === 'confidence' ? 'n/a' : 'fewer than 5';
  };
  $('#evt-table').innerHTML = `<div class="table-scroll evt-table"><table><thead><tr>${columns.map(c => `<th class="${c.text ? 'name' : ''}" aria-sort="${c.key === col.key ? (tableState.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${c.key}">${escapeHTML(c.label)}</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr data-id="${escapeHTML(r.id)}" tabindex="0">${columns.map(c => `<td class="${c.text ? 'name' : ''}">${show(r, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">Pace is the county's share of expected ballots cast relative to the state's. D share intervals are 90% intervals from the number of early voters with a primary history. Cells under 5 voters are suppressed. Forecast columns are the model's, not early-vote results.</p>`;
  markTable();
}
function markTable() {
  const ids = new Set([st.sel, st.hover].filter(x => x?.level === 'county').map(x => x.id));
  for (const tr of document.querySelectorAll('#evt-table tbody tr')) tr.classList.toggle('active', ids.has(tr.dataset.id));
}

// ---- Detail card ----
function drawCard() {
  const host = $('#evt-card');
  if (!st.sel) { host.innerHTML = '<p class="note">Click an area on the map, a point on a chart or a county in the table to see its details here.</p>'; return; }
  const d = st.sel.level === st.level ? data : county, row = rowAt(d, st.sel.id), f = d?.forecast.get(st.sel.id);
  const v = key => num(row?.[key]);
  const line = (label, value) => `<div class="evt-line"><span>${escapeHTML(label)}</span><strong>${value}</strong></div>`;
  let body = '';
  const tier = tierOf(v('early_ballots'));
  if (!row) body = line('Early ballots', 'no record');
  else if (tier === 'suppressed') body = line('Early ballots', 'fewer than 5 early voters') + line('Expected ballots', count(v('expected_ballots')));
  else {
    const ds = v('d_share_primary_history'), n = v('with_primary_history'), pace = paceOf(row), [plo, phi] = paceInterval(pace, v('early_ballots'));
    body = line('Early ballots', escapeHTML(showN(v('early_ballots'))))
      + line('In person / mail', `${escapeHTML(showN(v('in_person')))} / ${escapeHTML(showN(v('mail')))}`)
      + line('Expected ballots', count(v('expected_ballots')))
      + line('Pace vs the state', `${times(pace)} <span class="muted">90%: ${times(plo)}–${times(phi)}</span>`)
      + line('Signal reliability', escapeHTML(tierLabel[tier]))
      + line('% of registered', pct(v('pct_registered'))) + line('% of 2022 turnout', pct(v('pct_of_2022'))) + line("% of the model's expected ballots", pct(v('pct_of_expected')))
      + (Number.isFinite(ds) && Number.isFinite(n) ? (([lo, hi]) => line('D share, primary history', `${pct(ds)} <span class="muted">90%: ${pct(lo)}–${pct(hi)}, n = ${escapeHTML(showN(n))}</span>`))(shareInterval(ds, n)) : line('D share, primary history', 'fewer than 5 with a primary history'))
      + primaryBlock(row);
  }
  host.innerHTML = `<p class="place-kicker">${escapeHTML(st.sel.level === 'county' ? 'County' : st.sel.level === 'puma' ? 'PUMA' : 'Precinct')} · through ${escapeHTML(dateText(st.date))}</p><h3>${escapeHTML(labelOf(st.sel.level, st.sel.id, d))}</h3>${body}${forecastBlock(f)}
    <button type="button" class="text-button" id="evt-clear">Clear selection</button>`;
}

// ---- Controls ----
function syncControls() {
  for (const b of document.querySelectorAll('[data-evt-level]')) { const on = b.dataset.evtLevel === st.level; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
  $('#evt-measure').value = st.measure;
  const b = mapBasics(), kind = measureOf(st.measure).kind;
  const options = kind === 'pace' ? Object.entries(pacePalettes).map(([k, p]) => [k, p.label, k === st.ppal]) : Object.entries(kind === 'dshare' ? b.divergingPalettes : b.sequentialPalettes).filter(([k]) => k !== 'custom').map(([k, p]) => [k, p.label, k === (kind === 'dshare' ? st.dpal : st.spal)]);
  $('#evt-palette').replaceChildren(...options.map(([k, label, on]) => new Option(label, k, false, on)));
  const slider = $('#evt-date');
  slider.max = String(county.dates.length - 1);
  slider.value = String(Math.max(0, county.dates.indexOf(st.date)));
  $('#evt-date-label').textContent = `Through ${dateText(st.date)}`;
}
function renderAll() {
  syncControls(); syncDisplay(); drawSummary(); paintMap(); drawTrend(); drawPaceScatter(); drawBars(); drawRank(); drawScatter(); drawTable(); drawCard(); writeURL();
}
async function setLevel(level) {
  st.level = level; st.hover = null;
  data = await load(level);
  renderAll();
}
function setDate(index) {
  st.date = county.dates[Math.max(0, Math.min(county.dates.length - 1, index))];
  renderAll();
}
function stop() { clearInterval(timer); timer = null; $('#evt-play').textContent = 'Play'; $('#evt-play').setAttribute('aria-pressed', 'false'); }
function hookScatter(name, host) {
  const el = $(host);
  el.addEventListener('pointermove', e => {
    const p = pickFrom(name, host, e), tip = el.querySelector('.chart-tooltip');
    if (!p) { tip.hidden = true; setHover(null); return; }
    tip.innerHTML = p.bin ? `<strong>${p.n.toLocaleString('en-US')} ${escapeHTML(p.n === 1 ? levelNames[st.level].replace(/s$/, '') : levelNames[st.level])}</strong>Mean ${name === 'pace' ? `pace ${times(p.my)}` : `D share ${pct(p.my)}`}<br>Mean Talarico win probability ${probPct(p.mp)}` : tooltipHTML(st.level, p.id);
    tip.hidden = false;
    const x = p.x / p.scale, y = p.y / p.scale;
    tip.style.left = `${x + 12 + tip.offsetWidth > el.clientWidth ? Math.max(4, x - tip.offsetWidth - 12) : x + 12}px`; tip.style.top = `${Math.max(4, Math.min(el.clientHeight - tip.offsetHeight - 4, y - tip.offsetHeight / 2))}px`;
    if (!p.bin) setHover({ level:st.level, id:p.id });
  });
  el.addEventListener('pointerleave', () => { el.querySelector('.chart-tooltip').hidden = true; setHover(null); });
  el.addEventListener('click', e => { const p = pickFrom(name, host, e); if (p && !p.bin) setSelection({ level:st.level, id:p.id }); });
}

async function start() {
  if (started) return;
  started = true;
  const groups = [...new Set(measures.map(m => m.group))];
  $('#evt-measure').replaceChildren(...groups.map(g => { const og = document.createElement('optgroup'); og.label = g; og.append(...measures.filter(m => m.group === g).map(m => new Option(m.label, m.key))); return og; }));
  $('#evt-summary').innerHTML = '<p class="note">Loading early vote…</p>';
  try {
    const present = await fetch(`${base}data/optional.json`).then(r => r.ok ? r.json() : []).catch(() => []);
    county = await load('county');
    data = st.level === 'county' ? county : await load(st.level);
    if (present.includes('early_vote_daily.csv')) daily = new Map((await csv('early_vote_daily.csv').catch(() => [])).map(r => [r.date, r]));
  } catch (error) { $('#evt-summary').innerHTML = `<p class="note">Early-vote data could not be loaded: ${escapeHTML(error.message)}</p>`; return; }
  if (!st.date || !county.dates.includes(st.date)) st.date = county.dates.at(-1);
  initMap();
  map._evtStyle = mapBasics().style;
  renderAll();
  for (const b of document.querySelectorAll('[data-evt-level]')) b.addEventListener('click', () => setLevel(b.dataset.evtLevel));
  $('#evt-measure').addEventListener('change', e => { st.measure = e.target.value; renderAll(); });
  $('#evt-palette').addEventListener('change', e => { const kind = measureOf(st.measure).kind; if (kind === 'pace') st.ppal = e.target.value; else if (kind === 'dshare') st.dpal = e.target.value; else st.spal = e.target.value; paintMap(); writeURL(); });
  $('#evt-date').addEventListener('input', e => { stop(); setDate(+e.target.value); });
  $('#evt-play').addEventListener('click', () => {
    if (timer) return stop();
    if (county.dates.indexOf(st.date) >= county.dates.length - 1) setDate(0);
    $('#evt-play').textContent = 'Pause'; $('#evt-play').setAttribute('aria-pressed', 'true');
    timer = setInterval(() => { const next = county.dates.indexOf(st.date) + 1; if (next >= county.dates.length) return stop(); setDate(next); }, 1100);
  });
  for (const [id, key, parse] of [['#evt-op', 'op', Number], ['#evt-bw', 'bw', Number], ['#evt-ol', 'ol', Number], ['#evt-ln', 'ln', null]]) {
    $(id).addEventListener('input', e => { display[st.level][key] = parse ? parse(e.target.value) : e.target.checked; saveDisplay(); syncDisplay(); paintDisplay(); });
  }
  $('#evt-display-reset').addEventListener('click', () => { display[st.level] = { ...displayDefaults[st.level] }; saveDisplay(); syncDisplay(); paintDisplay(); });
  $('#evt-trend').addEventListener('click', e => { const hit = e.target.closest('[data-date]'); if (hit) { stop(); setDate(county.dates.indexOf(hit.dataset.date)); } });
  hookScatter('pace', '#evt-pace-scatter'); hookScatter('dshare', '#evt-scatter');
  for (const b of document.querySelectorAll('[data-bars]')) b.addEventListener('click', () => { st.bars = b.dataset.bars; drawBars(); });
  for (const b of document.querySelectorAll('[data-scatter-mode]')) b.addEventListener('click', () => { scatterMode[b.dataset.scatterMode] = b.dataset.mode; (b.dataset.scatterMode === 'pace' ? drawPaceScatter : drawScatter)(); });
  $('#evt-rank-more').addEventListener('click', () => { rankAll = !rankAll; drawRank(); });
  const rank = $('#evt-rank');
  rank.addEventListener('pointerover', e => { const r = e.target.closest('[data-id]'); setHover(r ? { level:st.level, id:r.dataset.id } : null); });
  rank.addEventListener('pointerleave', () => setHover(null));
  rank.addEventListener('click', e => { const r = e.target.closest('[data-id]'); if (r) setSelection({ level:st.level, id:r.dataset.id }); });
  const tableHost = $('#evt-table');
  tableHost.addEventListener('click', e => {
    const sort = e.target.closest('[data-sort]'), tr = e.target.closest('tr[data-id]');
    if (sort) { const key = sort.dataset.sort; if (tableState.sort === key) tableState.dir = -tableState.dir; else { tableState.sort = key; tableState.dir = columns.find(c => c.key === key).text ? 1 : -1; } drawTable(); }
    else if (tr) setSelection({ level:'county', id:tr.dataset.id });
  });
  tableHost.addEventListener('pointerover', e => { const tr = e.target.closest('tr[data-id]'); setHover(tr ? { level:'county', id:tr.dataset.id } : null); });
  tableHost.addEventListener('pointerleave', () => setHover(null));
  $('#evt-card').addEventListener('click', e => { if (e.target.closest('#evt-clear')) setSelection(null); });
  new ResizeObserver(() => { if (!tab.hidden) { drawTrend(); drawPaceScatter(); drawBars(); drawRank(); drawScatter(); map?.resize(); } }).observe(tab);
}

// ---- Tabs ----
function showView(view) {
  const early = view === 'early';
  tab.hidden = !early;
  document.querySelector('#app').classList.toggle('ev-view', early);
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  if (early) { start().then(() => { map?.resize(); }); } else stop();
  writeURL();
  window.dispatchEvent(new Event('panel-layout'));
}
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => showView(b.dataset.view));
// The tab appears only when the county early-vote file is published.
const tabButton = document.querySelector('[data-view="early"]');
tabButton.hidden = true;
fetch(`${base}data/optional.json`).then(r => r.ok ? r.json() : []).catch(() => []).then(present => {
  tabButton.hidden = !present.includes(files.county);
  if (!tabButton.hidden && params.get('tab') === 'early') showView('early');
});
