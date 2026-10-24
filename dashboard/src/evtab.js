import maplibregl from 'maplibre-gl';
import { scaleLinear } from 'd3-scale';
import { base, csv, pct, count, escapeHTML } from './data.js';
import { mapBasics } from './map.js';

// Early vote tab. One source for every number here: the published early_vote_map files, one row per area per day,
// cumulative through that day. Blank cells are withheld (fewer than 10 voters) and are never filled in or derived.
const files = { precinct:'early_vote_map_precinct.csv', puma:'early_vote_map_puma.csv', county:'early_vote_map_county.csv' };
const projections = { precinct:'regional_projections.csv', puma:'puma_projections.csv', county:'county_projections.csv' };
const levelNames = { precinct:'precincts', puma:'PUMAs', county:'counties' };
const measures = [
  { key:'pct_registered', label:'% of registered voters', kind:'share' },
  { key:'pct_of_2022', label:'% of 2022 turnout', kind:'share' },
  { key:'early_ballots', label:'Early ballots', kind:'count' },
  { key:'d_share_primary_history', label:'D share of early voters with a 2026 primary history', kind:'dshare' },
];
const params = new URLSearchParams(location.search);
const st = {
  level:files[params.get('evl')] ? params.get('evl') : 'county',
  measure:measures.some(m => m.key === params.get('evm')) ? params.get('evm') : 'pct_registered',
  date:params.get('evd') || null,
  spal:params.get('evs') || 'teal', dpal:params.get('evdp') || 'redblue',
  sel:null, hover:null,
};
const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
const measureOf = key => measures.find(m => m.key === key) || measures[0];
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : NaN;
const dateText = (d, year = false) => { const t = new Date(`${d}T12:00:00`); return Number.isNaN(+t) ? String(d) : t.toLocaleDateString('en-US', { month:'short', day:'numeric', ...(year ? { year:'numeric' } : {}) }); };
// Counts below 10 are never displayed, even where a published cell holds one.
const shown = n => !Number.isFinite(n) || n < 10 ? 'under 10' : count(n);
const lean = p => !Number.isFinite(p) ? null : p < .4 ? 'paxton' : p > .6 ? 'talarico' : 'tossup';
const leanLabel = { paxton:'Paxton favored', tossup:'Toss-up', talarico:'Talarico favored' };
// 90% interval for a share from n voters, clipped to [0, 1].
const shareInterval = (p, n) => { const h = 1.645 * Math.sqrt(p * (1 - p) / n); return [Math.max(0, p - h), Math.min(1, p + h)]; };

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
let data = null, county = null, map = null, mapReady = false, timer = null, started = false;
const labelOf = (level, id, d = level === st.level ? data : county) => d?.forecast.get(id)?.label || (level === 'county' ? `County ${id}` : id);
const rowAt = (d, id) => d?.byDate.get(st.date)?.get(id) || null;

function writeURL() {
  const url = new URL(location.href);
  if (tab.hidden) for (const key of ['tab', 'evl', 'evm', 'evd', 'evs', 'evdp']) url.searchParams.delete(key);
  else Object.entries({ tab:'early', evl:st.level, evm:st.measure, evd:st.date, evs:st.spal, evdp:st.dpal }).forEach(([k, v]) => v && url.searchParams.set(k, v));
  history.replaceState(null, '', url);
}

// ---- Map ----
function ramp(diverging) {
  const b = mapBasics(), palettes = diverging ? b.divergingPalettes : b.sequentialPalettes, key = diverging ? st.dpal : st.spal;
  return (palettes[key] || palettes[diverging ? 'redblue' : 'teal'])[b.theme];
}
const withheldFill = () => mapBasics().theme === 'dark' ? '#5b6670' : '#dde2e2';
function colorData() {
  const m = measureOf(st.measure), rows = data.byDate.get(st.date) || new Map(), values = {}, withheld = [];
  for (const [id, row] of rows) { const v = num(row[m.key]); if (Number.isFinite(v)) values[id] = v; else withheld.push(id); }
  return { m, values, withheld, range:data.ranges[m.key], diverging:m.kind === 'dshare' };
}
function fillExpression(d) {
  const b = mapBasics(), type = d.diverging ? 'share' : 'seq', colors = ramp(d.diverging), [lo, hi] = d.range;
  const id = ['to-string', ['get', 'region_id']], values = ['literal', d.values];
  const stops = Array.from({ length:9 }, (_, i) => i / 8).flatMap(t => [lo + t * (hi - lo), b.colorAt(colors, t, type)]);
  const withheld = d.withheld.length ? ['match', id, d.withheld, withheldFill(), '#afb8b8'] : '#afb8b8';
  return ['case', ['has', id, values], ['interpolate', ['linear'], ['to-number', ['get', id, values]], ...stops], withheld];
}
const idFilter = ids => ['in', ['to-string', ['get', 'region_id']], ['literal', ids]];
function hatchImage() {
  const size = 8, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = 'rgba(95,108,114,.55)'; ctx.lineWidth = 1.2;
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
    map.addLayer({ id:`evt-fill-${level}`, type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:vis }, paint:{ 'fill-color':'#afb8b8', 'fill-opacity':display[level].op / 100 } }, before);
    map.addLayer({ id:`evt-hatch-${level}`, type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:vis }, filter:idFilter([]), paint:{ 'fill-pattern':'evt-hatch' } }, before);
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
  map.setPaintProperty(`evt-fill-${st.level}`, 'fill-color', fillExpression(d));
  paintDisplay();
  map.setFilter(`evt-hatch-${st.level}`, idFilter(d.withheld));
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
  const b = mapBasics(), type = d.diverging ? 'share' : 'seq', colors = ramp(d.diverging), [lo, hi] = d.range;
  const gradient = Array.from({ length:9 }, (_, i) => `${b.colorAt(colors, i / 8, type)} ${(100 * i / 8).toFixed(1)}%`).join(',');
  const fmt = v => d.m.kind === 'count' ? count(v) : pct(v);
  $('#evt-legend').innerHTML = `<div class="legend-title">${escapeHTML(d.m.label)}, through ${escapeHTML(dateText(st.date))}</div><div class="legend-ramp" style="background:linear-gradient(90deg,${gradient})"></div>
    <div class="legend-edges"><span style="left:0.00%">${escapeHTML(fmt(lo))}</span><span style="left:50%">${escapeHTML(fmt((lo + hi) / 2))}</span><span style="left:100.00%">${escapeHTML(fmt(hi))}${d.diverging ? '' : '+'}</span></div>
    ${d.diverging ? '<div class="legend-ends"><span>More Republican</span><span>More Democratic</span></div>' : ''}
    <div class="legend-nodata"><span class="evt-hatch-swatch" style="background-color:${withheldFill()}"></span>${d.diverging ? 'Fewer than 10 with a primary history' : 'Fewer than 10 early voters'}</div>
    <div class="legend-note">${d.diverging ? 'Centered on 50%; the range is symmetric and fixed across dates.' : 'Range fixed across dates; values above it saturate.'}</div>`;
}
function tooltipHTML(level, id) {
  const d = level === st.level ? data : county, row = rowAt(d, id), f = d?.forecast.get(id);
  const head = `<strong>${escapeHTML(labelOf(level, id, d))}</strong>Through ${escapeHTML(dateText(st.date))}<br>`;
  if (!row) return `${head}No early-vote record for this area.`;
  const v = key => num(row[key]);
  if (!Number.isFinite(v('early_ballots'))) return `${head}Fewer than 10 early voters.`;
  const ds = v('d_share_primary_history'), n = v('with_primary_history');
  return head + [
    `Early ballots: ${shown(v('early_ballots'))} (${shown(v('in_person'))} in person / ${shown(v('mail'))} mail)`,
    `% of registered: ${pct(v('pct_registered'))} · % of 2022: ${pct(v('pct_of_2022'))}`,
    Number.isFinite(ds) && Number.isFinite(n) ? `D share with a primary history: ${pct(ds)} of ${shown(n)}` : 'D share: fewer than 10 with a primary history',
    f && Number.isFinite(f.mean) ? `Forecast: ${pct(f.mean)} Talarico, ${leanLabel[lean(f.p)]}` : '',
  ].filter(Boolean).map(escapeHTML).join('<br>');
}
function initMap() {
  const b = mapBasics();
  map = new maplibregl.Map({ container:'evt-map', style:b.style, bounds:b.bounds, fitBoundsOptions:{ padding:24 }, attributionControl:false });
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
    tip.style.left = `${e.point.x + 14 + w > box.width ? e.point.x - w - 14 : e.point.x + 14}px`;
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

// ---- Linked highlighting ----
function setHover(next) {
  if (st.hover?.id === next?.id && st.hover?.level === next?.level) return;
  st.hover = next;
  paintHighlight(); drawScatter(); markTable();
}
function setSelection(next) {
  st.sel = next;
  paintHighlight(); drawScatter(); markTable(); drawCard(); drawTrend();
}

// ---- Summary: sums over the county file at the selected date ----
function drawSummary() {
  const rows = [...(county.byDate.get(st.date) || new Map()).values()];
  const sum = key => rows.reduce((t, row) => t + (Number.isFinite(num(row[key])) ? num(row[key]) : 0), 0);
  const withheld = rows.filter(row => !Number.isFinite(num(row.early_ballots))).length;
  const noPrimary = rows.filter(row => !Number.isFinite(num(row.with_primary_history)) || !Number.isFinite(num(row.d_primary))).length;
  const ballots = sum('early_ballots'), person = sum('in_person'), mail = sum('mail');
  const primaryRows = rows.filter(row => Number.isFinite(num(row.with_primary_history)) && Number.isFinite(num(row.d_primary)));
  const n = primaryRows.reduce((t, row) => t + num(row.with_primary_history), 0), dCount = primaryRows.reduce((t, row) => t + num(row.d_primary), 0);
  const share = n > 0 ? dCount / n : NaN, [lo, hi] = n > 0 ? shareInterval(share, n) : [NaN, NaN];
  const cell = (label, value, sub = '') => `<div class="evt-stat"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong>${sub ? `<em>${escapeHTML(sub)}</em>` : ''}</div>`;
  $('#evt-summary').innerHTML = cell('Early ballots', shown(ballots), `through ${dateText(st.date, true)}`)
    + cell('In person · mail', `${shown(person)} · ${shown(mail)}`, ballots > 0 ? `${pct(person / ballots, 0)} in person` : '')
    + cell('With a 2026 primary history', shown(n), ballots > 0 ? `${pct(n / ballots, 0)} of early voters` : '')
    + cell('D share, primary history', pct(share), Number.isFinite(lo) ? `90% interval ${pct(lo)}–${pct(hi)}` : '')
    + cell('Counties withheld', String(withheld), `fewer than 10 early voters${noPrimary > withheld ? `; ${noPrimary} without a D share` : ''}`);
}

// ---- Cumulative chart: statewide, or the selected area ----
function drawTrend() {
  const host = $('#evt-trend'), width = Math.max(280, host.clientWidth || 420), height = 210, m = { top:12, right:14, bottom:24, left:48 };
  const target = st.sel ? (st.sel.level === st.level ? data : county) : null;
  let series;
  if (st.sel && target) {
    series = (target.byId.get(st.sel.id) || []).map(row => ({ date:row.date, person:num(row.in_person), mail:num(row.mail) }));
    $('#evt-trend-title').textContent = `Cumulative early ballots, ${labelOf(st.sel.level, st.sel.id, target)}`;
  } else {
    series = county.dates.map(date => { const rows = [...county.byDate.get(date).values()], sum = k => rows.reduce((t, r) => t + (Number.isFinite(num(r[k])) ? num(r[k]) : 0), 0); return { date, person:sum('in_person'), mail:sum('mail') }; });
    $('#evt-trend-title').textContent = 'Cumulative early ballots, statewide (sum of counties)';
  }
  const rows = series.filter(r => Number.isFinite(r.person) && Number.isFinite(r.mail) && r.person + r.mail >= 10);
  if (!rows.length) { host.innerHTML = '<p class="note">Fewer than 10 early voters on every date, so nothing is shown.</p>'; return; }
  const all = county.dates, x = d => m.left + (all.length === 1 ? 0 : all.indexOf(d) / (all.length - 1)) * (width - m.left - m.right);
  const top = Math.max(...rows.map(r => r.person + r.mail)) * 1.08, y = v => height - m.bottom - v / top * (height - m.top - m.bottom);
  const area = (lo, hi) => `M${rows.map(r => `${x(r.date).toFixed(1)},${y(hi(r)).toFixed(1)}`).join('L')}L${[...rows].reverse().map(r => `${x(r.date).toFixed(1)},${y(lo(r)).toFixed(1)}`).join('L')}Z`;
  const short = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v));
  const ticks = scaleLinear().domain([0, top]).ticks(4);
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cumulative early ballots by date">
    ${ticks.map(v => `<line class="evt-grid" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/><text class="evt-axis" x="${m.left - 5}" y="${y(v) + 3}" text-anchor="end">${short(v)}</text>`).join('')}
    <path class="evt-area person" d="${area(() => 0, r => r.person)}"/><path class="evt-area mail" d="${area(r => r.person, r => r.person + r.mail)}"/>
    <line class="evt-now" x1="${x(st.date)}" x2="${x(st.date)}" y1="${m.top}" y2="${height - m.bottom}"/>
    ${all.map((d, i) => `<text class="evt-axis" x="${x(d)}" y="${height - 7}" text-anchor="${i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}">${escapeHTML(dateText(d))}</text>`).join('')}
    ${all.map(d => `<rect class="evt-hit" data-date="${d}" x="${x(d) - 12}" y="${m.top}" width="24" height="${height - m.top - m.bottom}"/>`).join('')}
  </svg><div class="evt-keys"><span><i class="evt-key person"></i>In person</span><span><i class="evt-key mail"></i>Mail</span><span>Click a date to move the slider.</span></div>`;
}

// ---- Scatter: D share with a primary history against the forecast share ----
const MAX_POINTS = 5000;
let scatterHit = null;
function drawScatter() {
  const host = $('#evt-scatter'), width = Math.max(280, host.clientWidth || 420), height = 260, m = { top:10, right:12, bottom:34, left:44 };
  const rows = data.byDate.get(st.date) || new Map(), pts = [];
  for (const [id, row] of rows) {
    const ds = num(row.d_share_primary_history), n = num(row.with_primary_history), f = data.forecast.get(id);
    if (Number.isFinite(ds) && Number.isFinite(n) && f && Number.isFinite(f.mean)) pts.push({ id, ds, n, x:f.mean, lean:lean(f.p) });
  }
  pts.sort((a, b) => b.n - a.n);
  const capped = pts.length > MAX_POINTS, use = pts.slice(0, MAX_POINTS);
  const sx = scaleLinear().domain([0, 1]).range([m.left, width - m.right]), sy = scaleLinear().domain([0, 1]).range([height - m.bottom, m.top]);
  const nMax = use.length ? use[Math.min(use.length - 1, Math.floor(use.length * .02))].n : 1;
  const r = n => 1.6 + 5 * Math.sqrt(Math.min(1, n / nMax));
  const focus = [st.sel, st.hover].filter(x => x && x.level === st.level).map(x => x.id);
  const ticks = [0, .25, .5, .75, 1];
  const dots = [...use].reverse().map(p => `<circle class="evt-dot ${p.lean}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.ds).toFixed(1)}" r="${r(p.n).toFixed(1)}"/>`).join('');
  const rings = use.filter(p => focus.includes(p.id)).map(p => { const [lo, hi] = shareInterval(p.ds, p.n); return `<line class="evt-ci" x1="${sx(p.x)}" x2="${sx(p.x)}" y1="${sy(lo)}" y2="${sy(hi)}"/><circle class="evt-ring" cx="${sx(p.x)}" cy="${sy(p.ds)}" r="${r(p.n) + 4}"/>`; }).join('');
  const svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="D share of early voters with a primary history against forecast Talarico share">
    ${ticks.map(t => `<line class="evt-grid" x1="${sx(t)}" x2="${sx(t)}" y1="${m.top}" y2="${height - m.bottom}"/><line class="evt-grid" x1="${m.left}" x2="${width - m.right}" y1="${sy(t)}" y2="${sy(t)}"/><text class="evt-axis" x="${sx(t)}" y="${height - m.bottom + 12}" text-anchor="middle">${t * 100}%</text><text class="evt-axis" x="${m.left - 5}" y="${sy(t) + 3}" text-anchor="end">${t * 100}%</text>`).join('')}
    <line class="evt-mid" x1="${sx(.5)}" x2="${sx(.5)}" y1="${m.top}" y2="${height - m.bottom}"/><line class="evt-mid" x1="${m.left}" x2="${width - m.right}" y1="${sy(.5)}" y2="${sy(.5)}"/>
    ${dots}${rings}
    <text class="evt-axis label" x="${(m.left + width - m.right) / 2}" y="${height - 4}" text-anchor="middle">Forecast Talarico two-party share</text>
    <text class="evt-axis label" transform="translate(11 ${(m.top + height - m.bottom) / 2}) rotate(-90)" text-anchor="middle">D share, primary history</text></svg>`;
  const tip = host.querySelector('.chart-tooltip');
  host.innerHTML = svg; host.append(tip);
  scatterHit = use.map(p => ({ id:p.id, x:sx(p.x), y:sy(p.ds) }));
  $('#evt-scatter-note').textContent = `${pts.length.toLocaleString('en-US')} ${levelNames[st.level]} have a published D share${capped ? `; for speed only the ${MAX_POINTS.toLocaleString('en-US')} with the most primary-history voters are drawn` : ''}. Point size: early voters with a primary history. Colour: forecast lean (Paxton favored below a 40% win chance, Talarico favored above 60%). The line on a highlighted point is its 90% interval.`;
}
function scatterPick(event) {
  if (!scatterHit) return null;
  const svg = $('#evt-scatter svg'), box = svg.getBoundingClientRect(), k = svg.viewBox.baseVal.width / box.width;
  const mx = (event.clientX - box.left) * k, my = (event.clientY - box.top) * k;
  let best = null, bestD = 64;
  for (const p of scatterHit) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2; if (d < bestD) { bestD = d; best = p; } }
  return best ? { ...best, scale:k } : null;
}

// ---- County table ----
const tableState = { sort:'early_ballots', dir:-1 };
const columns = [
  { key:'name', label:'County', text:true },
  { key:'early_ballots', label:'Early ballots', type:'count' }, { key:'in_person', label:'In person', type:'count' }, { key:'mail', label:'Mail', type:'count' },
  { key:'pct_registered', label:'% registered', type:'share' }, { key:'pct_of_2022', label:'% of 2022', type:'share' }, { key:'pct_of_expected', label:'% of expected', type:'share' },
  { key:'d_share_primary_history', label:'D share, primary history', type:'dshare' }, { key:'forecast', label:'Forecast share', type:'share' }, { key:'lean', label:'Forecast lean', text:true },
];
function tableRows() {
  return [...(county.byDate.get(st.date) || new Map())].map(([id, row]) => {
    const f = county.forecast.get(id);
    return { id, row, name:labelOf('county', id, county), forecast:f?.mean, lean:f ? leanLabel[lean(f.p)] || '' : '' };
  });
}
const cellValue = (r, c) => c.key === 'name' ? r.name : c.key === 'lean' ? r.lean : c.key === 'forecast' ? r.forecast : num(r.row[c.key]);
function drawTable() {
  const col = columns.find(c => c.key === tableState.sort) || columns[1];
  const rows = tableRows().sort((a, b) => { const p = cellValue(a, col), q = cellValue(b, col); return (col.text ? String(p).localeCompare(String(q)) : (Number.isFinite(p) ? p : -Infinity) - (Number.isFinite(q) ? q : -Infinity)) * tableState.dir; });
  const show = (r, c) => {
    const v = cellValue(r, c);
    if (c.text) return escapeHTML(v);
    if (c.type === 'count') return Number.isFinite(num(r.row.early_ballots)) ? shown(v) : 'withheld';
    if (c.type === 'dshare') { const n = num(r.row.with_primary_history); if (!Number.isFinite(v) || !Number.isFinite(n)) return '<span class="muted">under 10</span>'; const [lo, hi] = shareInterval(v, n); return `${pct(v)} <span class="muted">(${pct(lo)}–${pct(hi)})</span>`; }
    return Number.isFinite(v) ? pct(v) : c.key === 'forecast' ? 'n/a' : 'withheld';
  };
  $('#evt-table').innerHTML = `<div class="table-scroll evt-table"><table><thead><tr>${columns.map(c => `<th class="${c.text ? 'name' : ''}" aria-sort="${c.key === col.key ? (tableState.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${c.key}">${escapeHTML(c.label)}</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr data-id="${escapeHTML(r.id)}" tabindex="0">${columns.map(c => `<td class="${c.text ? 'name' : ''}">${show(r, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">D share intervals are 90% intervals from the number of early voters with a primary history. Withheld cells describe fewer than 10 voters.</p>`;
  markTable();
}
function markTable() {
  const ids = new Set([st.sel, st.hover].filter(x => x?.level === 'county').map(x => x.id));
  for (const tr of document.querySelectorAll('#evt-table tbody tr')) tr.classList.toggle('active', ids.has(tr.dataset.id));
}

// ---- Detail card ----
function drawCard() {
  const host = $('#evt-card');
  if (!st.sel) { host.innerHTML = '<p class="note">Click an area on the map, a point on the chart or a county in the table to see its details here.</p>'; return; }
  const d = st.sel.level === st.level ? data : county, row = rowAt(d, st.sel.id), f = d?.forecast.get(st.sel.id);
  const v = key => num(row?.[key]);
  const line = (label, value) => `<div class="evt-line"><span>${escapeHTML(label)}</span><strong>${value}</strong></div>`;
  let body = '';
  if (!row || !Number.isFinite(v('early_ballots'))) body = line('Early ballots', 'fewer than 10 early voters');
  else {
    const ds = v('d_share_primary_history'), n = v('with_primary_history');
    body = line('Early ballots', escapeHTML(shown(v('early_ballots'))))
      + line('In person / mail', `${escapeHTML(shown(v('in_person')))} / ${escapeHTML(shown(v('mail')))}`)
      + line('% of registered', pct(v('pct_registered'))) + line('% of 2022 turnout', pct(v('pct_of_2022'))) + line("% of the model's expected ballots", pct(v('pct_of_expected')))
      + (Number.isFinite(ds) && Number.isFinite(n) ? (([lo, hi]) => line('D share, primary history', `${pct(ds)} <span class="muted">90%: ${pct(lo)}–${pct(hi)}, n = ${escapeHTML(shown(n))}</span>`))(shareInterval(ds, n)) : line('D share, primary history', 'fewer than 10 with a primary history'));
  }
  if (f) body += line('Forecast Talarico share', pct(f.mean)) + line('Talarico win probability', pct(f.p, 0)) + line('Forecast lean', escapeHTML(leanLabel[lean(f.p)] || 'n/a')) + line('Forecast confidence', pct(f.confidence, 0));
  host.innerHTML = `<p class="place-kicker">${escapeHTML(st.sel.level === 'county' ? 'County' : st.sel.level === 'puma' ? 'PUMA' : 'Precinct')} · through ${escapeHTML(dateText(st.date))}</p><h3>${escapeHTML(labelOf(st.sel.level, st.sel.id, d))}</h3>${body}
    <p class="note">Pace against the model's expected ballots will be added once expected ballots are published for each area.</p><button type="button" class="text-button" id="evt-clear">Clear selection</button>`;
}

// ---- Controls ----
function syncControls() {
  for (const b of document.querySelectorAll('[data-evt-level]')) { const on = b.dataset.evtLevel === st.level; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
  $('#evt-measure').value = st.measure;
  const b = mapBasics(), diverging = measureOf(st.measure).kind === 'dshare', palettes = diverging ? b.divergingPalettes : b.sequentialPalettes;
  $('#evt-palette').replaceChildren(...Object.entries(palettes).filter(([k]) => k !== 'custom').map(([k, p]) => new Option(p.label, k, false, k === (diverging ? st.dpal : st.spal))));
  const slider = $('#evt-date');
  slider.max = String(county.dates.length - 1);
  slider.value = String(Math.max(0, county.dates.indexOf(st.date)));
  $('#evt-date-label').textContent = `Through ${dateText(st.date)}`;
}
function renderAll() {
  syncControls(); syncDisplay(); drawSummary(); paintMap(); drawTrend(); drawScatter(); drawTable(); drawCard(); writeURL();
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

async function start() {
  if (started) return;
  started = true;
  $('#evt-measure').replaceChildren(...measures.map(m => new Option(m.label, m.key)));
  $('#evt-summary').innerHTML = '<p class="note">Loading early vote…</p>';
  try {
    county = await load('county');
    data = st.level === 'county' ? county : await load(st.level);
  } catch (error) { $('#evt-summary').innerHTML = `<p class="note">Early-vote data could not be loaded: ${escapeHTML(error.message)}</p>`; return; }
  if (!st.date || !county.dates.includes(st.date)) st.date = county.dates.at(-1);
  initMap();
  map._evtStyle = mapBasics().style;
  renderAll();
  for (const b of document.querySelectorAll('[data-evt-level]')) b.addEventListener('click', () => setLevel(b.dataset.evtLevel));
  $('#evt-measure').addEventListener('change', e => { st.measure = e.target.value; renderAll(); });
  $('#evt-palette').addEventListener('change', e => { if (measureOf(st.measure).kind === 'dshare') st.dpal = e.target.value; else st.spal = e.target.value; paintMap(); writeURL(); });
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
  const scatter = $('#evt-scatter');
  scatter.addEventListener('pointermove', e => {
    const p = scatterPick(e), tip = scatter.querySelector('.chart-tooltip');
    if (!p) { tip.hidden = true; setHover(null); return; }
    tip.innerHTML = tooltipHTML(st.level, p.id); tip.hidden = false;
    const x = p.x / p.scale, y = p.y / p.scale;
    tip.style.left = `${x + 12 + tip.offsetWidth > scatter.clientWidth ? x - tip.offsetWidth - 12 : x + 12}px`; tip.style.top = `${Math.max(4, y - tip.offsetHeight / 2)}px`;
    setHover({ level:st.level, id:p.id });
  });
  scatter.addEventListener('pointerleave', () => { scatter.querySelector('.chart-tooltip').hidden = true; setHover(null); });
  scatter.addEventListener('click', e => { const p = scatterPick(e); if (p) setSelection({ level:st.level, id:p.id }); });
  const tableHost = $('#evt-table');
  tableHost.addEventListener('click', e => {
    const sort = e.target.closest('[data-sort]'), tr = e.target.closest('tr[data-id]');
    if (sort) { const key = sort.dataset.sort; if (tableState.sort === key) tableState.dir = -tableState.dir; else { tableState.sort = key; tableState.dir = columns.find(c => c.key === key).text ? 1 : -1; } drawTable(); }
    else if (tr) setSelection({ level:'county', id:tr.dataset.id });
  });
  tableHost.addEventListener('pointerover', e => { const tr = e.target.closest('tr[data-id]'); setHover(tr ? { level:'county', id:tr.dataset.id } : null); });
  tableHost.addEventListener('pointerleave', () => setHover(null));
  $('#evt-card').addEventListener('click', e => { if (e.target.closest('#evt-clear')) setSelection(null); });
  new ResizeObserver(() => { if (!tab.hidden) { drawTrend(); drawScatter(); map?.resize(); } }).observe(tab);
}

// ---- Tabs ----
function showView(view) {
  const early = view === 'early';
  tab.hidden = !early;
  document.querySelector('#app').classList.toggle('ev-view', early);
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  if (early) { start().then(() => map?.resize()); } else stop();
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
