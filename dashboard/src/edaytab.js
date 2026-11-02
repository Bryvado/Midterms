import maplibregl from 'maplibre-gl';
import { scaleLinear } from 'd3-scale';
import { base, pct, probPct, count, escapeHTML } from './data.js';
import { mapBasics } from './map.js';
import { showView } from './evtab.js';

// Election night tab. Everything shown comes from data/live: live.json (the estimator's current statewide and county
// output), trajectory.json (one statewide row per snapshot) and source.json (live feed or rehearsal). Nothing is estimated here.
const tab = document.querySelector('#eday-tab');
const $ = selector => tab.querySelector(selector);
const tabButton = document.querySelector('[data-view="eday"]');
const params = new URLSearchParams(location.search);
const POLL_MS = 20000;
const SHIFT_MAX = .06;
const st = { live:null, traj:[], source:null, loadedAt:null, error:null, sort:'expected_total', dir:-1, hover:null, sel:null };
let map = null, mapReady = false, timer = null, started = false;

const dark = () => document.documentElement.dataset.layout === 'dark';
const fetchJSON = name => fetch(`${base}data/live/${name}?t=${Date.now()}`, { cache:'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error(`${name}: ${r.status}`)));
const central = utc => { const d = new Date(utc); return Number.isNaN(+d) ? String(utc ?? '') : d.toLocaleTimeString('en-US', { timeZone:'America/Chicago', hour:'numeric', minute:'2-digit' }); };
const centralFull = utc => { const d = new Date(utc); return Number.isNaN(+d) ? String(utc ?? '') : `${d.toLocaleString('en-US', { timeZone:'America/Chicago', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })} Central`; };
const pts = v => Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(100 * v).toFixed(1)} pts` : 'n/a';
const share = v => Number.isFinite(v) ? pct(v, 1) : '–';
const marginText = v => !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? 'Talarico' : 'Paxton'} +${count(Math.abs(v))}`;
const shiftColor = scaleLinear().domain([-SHIFT_MAX, -SHIFT_MAX / 2, 0, SHIFT_MAX / 2, SHIFT_MAX]).range(['#b2453c', '#d9a19b', '#e9ecec', '#93b4c4', '#1d6483']).clamp(true);
const shiftColorDark = scaleLinear().domain([-SHIFT_MAX, -SHIFT_MAX / 2, 0, SHIFT_MAX / 2, SHIFT_MAX]).range(['#ef8a7f', '#a86b66', '#3a4650', '#4f8aa8', '#5fcaf2']).clamp(true);
const counties = () => st.live?.counties || [];
const byId = () => new Map(counties().map(c => [c.fips3, c]));

// ---- Loading ----
async function refresh() {
  try {
    const [live, traj, source] = await Promise.all([fetchJSON('live.json'), fetchJSON('trajectory.json').catch(() => []), fetchJSON('source.json').catch(() => null)]);
    st.live = live; st.traj = Array.isArray(traj) ? traj : []; st.source = source; st.loadedAt = new Date(); st.error = null;
  } catch (error) { st.error = error; }
  render();
}
function render() {
  renderStatus();
  if (!st.live) return;
  renderSummary(); paintMap(); renderLegend(); drawTrajectory(); drawTable();
}
function renderStatus() {
  const banner = $('#eday-banner');
  const replay = st.source?.source === 'replay';
  banner.hidden = !replay;
  if (replay) banner.textContent = `Rehearsal: these are simulated returns (${st.source.folder || 'replay'}), not real results.`;
  const s = st.live?.statewide;
  $('#eday-status').textContent = st.error && !st.live ? `Election-night results are not available: ${st.error.message}`
    : s ? `Returns as of ${centralFull(s.snapshot_utc)}. ${count(s.counties_reporting)} of ${count(counties().length)} counties reporting, ${count(s.counties_complete)} complete. Checked ${st.loadedAt.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', second:'2-digit' })}; this page checks again every ${POLL_MS / 1000} seconds.`
    : 'Loading election-night results…';
}
function renderSummary() {
  const s = st.live.statewide;
  const stat = (label, value, note) => `<div class="evt-stat"><span>${escapeHTML(label)}</span><strong>${value}</strong><em>${escapeHTML(note)}</em></div>`;
  $('#eday-summary').innerHTML = [
    stat('Chance Talarico wins', probPct(s.p_talarico), `Pre-election simulations (07): ${probPct(s.p_talarico_prior)}`),
    stat('Talarico two-party share', share(s.tal_2p_mean), `80% range ${share(s.tal_2p_q10)} to ${share(s.tal_2p_q90)}`),
    stat('Margin', escapeHTML(marginText(s.margin_mean)), `80% range ${marginText(s.margin_q10)} to ${marginText(s.margin_q90)}`),
    stat('Votes counted', count(s.votes_counted), `of about ${count(s.votes_expected)} expected (${pct(s.pct_counted, 0)})`),
    stat('Counties', `${count(s.counties_reporting)} reporting`, `${count(s.counties_complete)} of ${count(counties().length)} complete`),
    stat('Election Day turnout factor', Number.isFinite(s.eday_turnout_factor) ? `${s.eday_turnout_factor.toFixed(2)}×` : 'n/a', 'Election Day votes against the model, from complete counties'),
    stat('Early minus Election Day', pts(s.early_gap_mean), `Talarico share gap, ± ${Number.isFinite(s.early_gap_sd) ? (100 * s.early_gap_sd).toFixed(1) : 'n/a'} pts`),
  ].join('');
}

// ---- Map: shift from the pre-election model, faded by how much of the county's expected vote is counted ----
function addLayers() {
  const b = mapBasics();
  map.addSource('eday-county', { type:'vector', url:b.tileURL(b.tiles.county), promoteId:'region_id' });
  map.addLayer({ id:'eday-fill', type:'fill', source:'eday-county', 'source-layer':'regions', paint:{ 'fill-color':'#cfd5d5', 'fill-opacity':.15 } });
  map.addLayer({ id:'eday-line', type:'line', source:'eday-county', 'source-layer':'regions', paint:{ 'line-color':b.theme === 'dark' ? 'rgba(220,230,235,.35)' : 'rgba(40,55,60,.3)', 'line-width':.5 } });
  map.addLayer({ id:'eday-hi', type:'line', source:'eday-county', 'source-layer':'regions', filter:['in', ['to-string', ['get', 'region_id']], ['literal', []]], paint:{ 'line-color':b.theme === 'dark' ? '#ffffff' : '#111a1f', 'line-width':2.4 } });
  b.labels(map);
  mapReady = true;
  paintMap();
}
function paintMap() {
  if (!map || !mapReady || !map.getLayer('eday-fill')) return;
  const ramp = dark() ? shiftColorDark : shiftColor, colors = {}, opacity = {};
  for (const c of counties()) {
    colors[c.fips3] = Number.isFinite(c.shift) ? ramp(c.shift) : '#cfd5d5';
    opacity[c.fips3] = .12 + .83 * Math.max(0, Math.min(1, Number.isFinite(c.pct_counted) ? c.pct_counted : 0));
  }
  const key = ['to-string', ['get', 'region_id']];
  map.setPaintProperty('eday-fill', 'fill-color', ['coalesce', ['get', key, ['literal', colors]], '#cfd5d5']);
  map.setPaintProperty('eday-fill', 'fill-opacity', ['coalesce', ['get', key, ['literal', opacity]], .12]);
  const ids = [st.sel, st.hover].filter(Boolean);
  map.setFilter('eday-hi', ['in', key, ['literal', ids]]);
}
function renderLegend() {
  $('#eday-legend').innerHTML = `<div class="eday-legend-title">Shift from the pre-election model</div><div class="eday-ramp"></div>
    <div class="eday-legend-scale"><span>Paxton +${100 * SHIFT_MAX}</span><span>0</span><span>Talarico +${100 * SHIFT_MAX}</span></div>
    <div class="eday-legend-note">Points of Talarico two-party share. Fainter counties have less of their expected vote counted.</div>`;
}
function tooltipHTML(c) {
  if (!c) return '';
  const line = (k, v) => `${escapeHTML(k)}: ${v}`;
  return `<strong>${escapeHTML(titleCase(c.county))}</strong>${[
    line('Counted', `${count(c.counted_early)} early, ${count(c.counted_eday)} Election Day (${pct(c.pct_counted, 0)} of expected)${c.complete ? ', complete' : ''}`),
    line('Talarico share, early', share(c.obs_2p_early)), line('Talarico share, Election Day', share(c.obs_2p_eday)),
    line('Pre-election model', share(c.prior_2p)), line('Estimate', `${share(c.post_2p)} ± ${Number.isFinite(c.post_2p_sd) ? (100 * c.post_2p_sd).toFixed(1) : 'n/a'} pts`),
    line('Shift', pts(c.shift)), line('Chance Talarico carries the county', probPct(c.p_talarico)),
  ].join('<br>')}`;
}
const titleCase = s => String(s ?? '').toLowerCase().replace(/(^|[\s-])\S/g, m => m.toUpperCase());
function initMap() {
  const b = mapBasics();
  map = new maplibregl.Map({ container:'eday-map', style:b.style, bounds:b.bounds, fitBoundsOptions:{ padding:24 }, attributionControl:false, cooperativeGestures:true });
  map.addControl(new maplibregl.AttributionControl({ compact:true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass:false }), 'top-right');
  map.on('style.load', addLayers);
  const wrap = tab.querySelector('.evt-map-wrap');
  let fitted = false;
  new ResizeObserver(() => { if (!wrap.clientWidth || !wrap.clientHeight) return; map.resize(); if (!fitted) { fitted = true; map.fitBounds(b.bounds, { padding:24, duration:0 }); } }).observe(wrap);
  const tip = $('#eday-tooltip');
  map.on('mousemove', e => {
    const f = mapReady && map.queryRenderedFeatures(e.point, { layers:['eday-fill'] })[0];
    map.getCanvas().style.cursor = f ? 'pointer' : '';
    const c = f && byId().get(String(f.properties.region_id));
    if (!c) { tip.hidden = true; setHover(null); return; }
    tip.innerHTML = tooltipHTML(c); tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight, box = map.getContainer().getBoundingClientRect();
    tip.style.left = `${e.point.x + 14 + w > box.width ? Math.max(4, e.point.x - w - 14) : e.point.x + 14}px`;
    tip.style.top = `${Math.max(6, Math.min(box.height - h - 6, e.point.y - h / 2))}px`;
    setHover(c.fips3);
  });
  map.on('mouseout', () => { tip.hidden = true; setHover(null); });
  map.on('click', e => { const f = mapReady && map.queryRenderedFeatures(e.point, { layers:['eday-fill'] })[0]; setSelection(f ? String(f.properties.region_id) : null); });
}
function setHover(id) { if (st.hover === id) return; st.hover = id; paintMap(); markTable(); }
function setSelection(id) {
  st.sel = st.sel === id ? null : id; paintMap(); markTable();
  if (st.sel) tab.querySelector(`#eday-table tr[data-id="${st.sel}"]`)?.scrollIntoView({ block:'nearest' });
}

// ---- Trajectory: chance of winning, then the two-party share with its 80% range, against snapshot time ----
function drawTrajectory() {
  const host = $('#eday-traj'), tip = host.querySelector('.chart-tooltip');
  const rows = st.traj.filter(r => Number.isFinite(new Date(r.snapshot_utc).getTime()));
  const prior = st.live?.statewide?.p_talarico_prior;
  host.querySelector('svg')?.remove();
  const W = Math.max(280, host.clientWidth || 360), H1 = 150, H2 = 170, gap = 34, m = { l:40, r:12, t:16, b:22 }, H = H1 + gap + H2 + m.b;
  if (rows.length < 1) { host.insertAdjacentHTML('afterbegin', `<p class="note">No snapshots yet.</p>`); return; }
  const t = rows.map(r => new Date(r.snapshot_utc).getTime());
  const x = scaleLinear().domain(t.length > 1 ? [t[0], t.at(-1)] : [t[0] - 6e5, t[0] + 6e5]).range([m.l, W - m.r]);
  const y1 = scaleLinear().domain([0, 1]).range([m.t + H1 - 18, m.t]);
  const lo = Math.min(...rows.map(r => r.tal_2p_q10), .48), hi = Math.max(...rows.map(r => r.tal_2p_q90), .52);
  const pad = (hi - lo) * .08, top2 = m.t + H1 + gap;
  const y2 = scaleLinear().domain([lo - pad, hi + pad]).nice().range([top2 + H2 - 18, top2]);
  const path = (f, y) => rows.map((r, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(f(r)).toFixed(1)}`).join('');
  const band = `${rows.map((r, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y2(r.tal_2p_q90).toFixed(1)}`).join('')}${rows.map((r, i) => `L${x(t[rows.length - 1 - i]).toFixed(1)},${y2(rows[rows.length - 1 - i].tal_2p_q10).toFixed(1)}`).join('')}Z`;
  const xt = x.ticks(Math.max(2, Math.floor(W / 90)));
  const grid = (y, ticks, fmt) => ticks.map(v => `<line class="evt-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="evt-axis" x="${m.l - 5}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`).join('');
  const xAxis = yb => xt.map(v => `<text class="evt-axis" x="${x(v)}" y="${yb + 13}" text-anchor="middle">${escapeHTML(central(v))}</text>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chance Talarico wins and his two-party share through the night">
    <text class="evt-axis label" x="${m.l}" y="${m.t - 5}">Chance Talarico wins</text>
    ${grid(y1, [0, .25, .5, .75, 1], v => `${Math.round(100 * v)}%`)}
    ${Number.isFinite(prior) ? `<line class="eday-prior" x1="${m.l}" x2="${W - m.r}" y1="${y1(prior)}" y2="${y1(prior)}"/><text class="evt-axis" x="${W - m.r}" y="${y1(prior) - 4}" text-anchor="end">Pre-election simulations ${probPct(prior)}</text>` : ''}
    <path class="eday-line p" d="${path(r => r.p_talarico, y1)}"/>
    ${xAxis(y1.range()[0])}
    <text class="evt-axis label" x="${m.l}" y="${top2 - 5}">Talarico two-party share, with 80% range</text>
    ${grid(y2, y2.ticks(4), v => `${(100 * v).toFixed(0)}%`)}
    ${.5 >= y2.domain()[0] && .5 <= y2.domain()[1] ? `<line class="evt-mid" x1="${m.l}" x2="${W - m.r}" y1="${y2(.5)}" y2="${y2(.5)}"/>` : ''}
    <path class="eday-band" d="${band}"/><path class="eday-line s" d="${path(r => r.tal_2p_mean, y2)}"/>
    ${xAxis(y2.range()[0])}
    <line class="eday-cross" x1="0" x2="0" y1="${m.t}" y2="${y2.range()[0]}" visibility="hidden"/>
    <rect class="evt-hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${y2.range()[0] - m.t}"/></svg>`;
  host.insertAdjacentHTML('afterbegin', svg);
  const el = host.querySelector('svg'), cross = el.querySelector('.eday-cross');
  el.querySelector('.evt-hit').addEventListener('pointermove', e => {
    const box = el.getBoundingClientRect(), px = (e.clientX - box.left) * W / box.width;
    let k = 0; for (let i = 1; i < t.length; i++) if (Math.abs(x(t[i]) - px) < Math.abs(x(t[k]) - px)) k = i;
    const r = rows[k], cx = x(t[k]);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<strong>${escapeHTML(centralFull(r.snapshot_utc))}</strong>Chance Talarico wins: ${probPct(r.p_talarico)}<br>Two-party share: ${share(r.tal_2p_mean)} (${share(r.tal_2p_q10)} to ${share(r.tal_2p_q90)})<br>Margin: ${escapeHTML(marginText(r.margin_mean))}<br>Counted: ${count(r.votes_counted)} (${pct(r.pct_counted, 0)})<br>Counties complete: ${count(r.counties_complete)}`;
    tip.hidden = false;
    const sx = cx * box.width / W;
    tip.style.left = `${sx + 12 + tip.offsetWidth > box.width ? Math.max(4, sx - tip.offsetWidth - 12) : sx + 12}px`; tip.style.top = '8px';
  });
  el.querySelector('.evt-hit').addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
}

// ---- County table ----
const columns = [
  { key:'county', label:'County', text:true, show:c => escapeHTML(titleCase(c.county)) },
  { key:'counted_early', label:'Counted early', show:c => count(c.counted_early) },
  { key:'counted_eday', label:'Counted Election Day', show:c => count(c.counted_eday) },
  { key:'pct_counted', label:'% of expected', show:c => pct(c.pct_counted, 0) },
  { key:'complete', label:'Complete', show:c => c.complete ? '<span class="eday-yes">Yes</span>' : '' },
  { key:'obs_2p_early', label:'Early share', show:c => share(c.obs_2p_early) },
  { key:'obs_2p_eday', label:'Election Day share', show:c => share(c.obs_2p_eday) },
  { key:'prior_2p', label:'Pre-election model', show:c => share(c.prior_2p) },
  { key:'post_2p', label:'Estimate', show:c => share(c.post_2p) },
  { key:'shift', label:'Shift', show:c => pts(c.shift) },
  { key:'expected_total', label:'Expected votes', show:c => count(c.expected_total) },
];
function drawTable() {
  const col = columns.find(c => c.key === st.sort) || columns.at(-1);
  const val = c => col.key === 'complete' ? +!!c.complete : c[col.key];
  const rows = [...counties()].sort((a, b) => {
    const p = val(a), q = val(b);
    return (col.text ? String(p).localeCompare(String(q)) : (Number.isFinite(p) ? p : -Infinity) - (Number.isFinite(q) ? q : -Infinity)) * st.dir;
  });
  $('#eday-table').innerHTML = `<div class="table-scroll evt-table"><table><thead><tr>${columns.map(c => `<th class="${c.text ? 'name' : ''}" aria-sort="${c.key === col.key ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${c.key}">${escapeHTML(c.label)}</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(c => `<tr data-id="${escapeHTML(c.fips3)}" tabindex="0">${columns.map(k => `<td class="${k.text ? 'name' : ''}">${k.show(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">Shares are Talarico's share of the two-party vote. Early and Election Day shares are the counted votes so far; the estimate is the updated county share. A dash means no votes of that kind are counted yet.</p>`;
  markTable();
}
function markTable() {
  const ids = new Set([st.sel, st.hover].filter(Boolean));
  for (const tr of tab.querySelectorAll('#eday-table tbody tr')) tr.classList.toggle('active', ids.has(tr.dataset.id));
}

// ---- Tab ----
function start() {
  if (!started) {
    started = true;
    initMap();
    $('#eday-table').addEventListener('click', e => {
      const sort = e.target.closest('[data-sort]'), tr = e.target.closest('tr[data-id]');
      if (sort) { const key = sort.dataset.sort; if (st.sort === key) st.dir = -st.dir; else { st.sort = key; st.dir = columns.find(c => c.key === key).text ? 1 : -1; } drawTable(); }
      else if (tr) setSelection(tr.dataset.id);
    });
    $('#eday-table').addEventListener('pointerover', e => { const tr = e.target.closest('tr[data-id]'); setHover(tr ? tr.dataset.id : null); });
    $('#eday-table').addEventListener('pointerleave', () => setHover(null));
    new ResizeObserver(() => { if (!tab.hidden && st.live) drawTrajectory(); }).observe($('#eday-traj'));
    new MutationObserver(() => { if (!tab.hidden) { paintMap(); } }).observe(document.documentElement, { attributes:true, attributeFilter:['data-layout'] });
  }
  refresh();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}
window.addEventListener('view-tab', ({ detail }) => {
  const on = detail.view === 'eday';
  tab.hidden = !on;
  const url = new URL(location.href);
  if (on) { url.searchParams.set('tab', 'eday'); start(); map?.resize(); }
  else { clearInterval(timer); timer = null; if (url.searchParams.get('tab') === 'eday') url.searchParams.delete('tab'); }
  history.replaceState(null, '', url);
});
// The tab button appears once the live feed is published. A rehearsal stays reachable only through ?tab=eday.
fetchJSON('source.json').then(source => {
  const asked = params.get('tab') === 'eday';
  tabButton.hidden = !(source?.source === 'live' || asked);
  if (asked) showView('eday');
}).catch(() => { if (params.get('tab') === 'eday') { tabButton.hidden = false; showView('eday'); } });
