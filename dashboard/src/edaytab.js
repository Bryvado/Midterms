import maplibregl from 'maplibre-gl';
import { scaleLinear } from 'd3-scale';
import { base, csv, pct, probPct, count, escapeHTML } from './data.js';
import { mapBasics } from './map.js';
import { showView } from './evtab.js';
import { resultsAvailable, activate as activateResults } from './resultsmap.js';
import { ensureStore } from './compare.js';
import { ramp as palRamp, partisanT, partisanClamp, partisanCenter, gradient, swatchButton } from './palette.js';

// Election night tab. Everything shown comes from data/live: live.json (the estimator's current statewide and county
// output), trajectory.json (one statewide row per snapshot) and, once the night's series is rebuilt, observed.json (raw
// statewide Senate counts by vote type). ?src=rehearsal reads the rehearsal copy under data/rehearsal instead and labels it
// as simulated. Nothing is estimated here. When every county is complete the tab switches to a final-results view.
const tab = document.querySelector('#eday-tab');
const $ = selector => tab.querySelector(selector);
const tabButton = document.querySelector('[data-view="eday"]');
const params = new URLSearchParams(location.search);
const POLL_MS = 20000;
const SHIFT_MAX = .06;
const rehearsal = params.get('src') === 'rehearsal';
const COUNTIES = 254;
const st = { live:null, traj:[], observed:null, loadedAt:null, error:null, sort:'expected_total', dir:-1, hover:null, sel:null, active:false };
let tipId = null, tipSize = { w:0, h:0 };
let map = null, mapReady = false, timer = null, started = false, resultsOK = null, forecast = null;

const fetchJSON = name => fetch(`${base}data/${rehearsal ? 'rehearsal' : 'live'}/${name}?t=${Date.now()}`, { cache:'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error(`${name}: ${r.status}`)));
const central = utc => { const d = new Date(utc); return Number.isNaN(+d) ? String(utc ?? '') : d.toLocaleTimeString('en-US', { timeZone:'America/Chicago', hour:'numeric', minute:'2-digit' }); };
const centralFull = utc => { const d = new Date(utc); return Number.isNaN(+d) ? String(utc ?? '') : `${d.toLocaleString('en-US', { timeZone:'America/Chicago', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })} Central`; };
const centralClock = date => `${date.toLocaleTimeString('en-US', { timeZone:'America/Chicago', hour:'numeric', minute:'2-digit', second:'2-digit' })} Central`;
const pts = v => Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(100 * v).toFixed(1)} pts` : 'n/a';
const share = v => Number.isFinite(v) ? pct(v, 1) : '–';
const marginText = v => !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? 'Talarico' : 'Paxton'} +${count(Math.abs(v))}`;
// The margin card's 80% range uses compact figures (92.4K, 1.11M), names the leader once when both ends favor the
// same candidate, and keeps each figure on one line, so the note stays within two lines.
const compact = new Intl.NumberFormat('en-US', { notation:'compact', maximumSignificantDigits:3 });
const nb = text => `<span class="nowrap">${escapeHTML(text)}</span>`;
const side = v => `${v >= 0 ? 'Talarico' : 'Paxton'} +${compact.format(Math.abs(v))}`;
function marginRange(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 'n/a';
  if ((lo >= 0) === (hi >= 0)) { const near = Math.abs(lo) < Math.abs(hi) ? lo : hi, far = near === lo ? hi : lo; return `${nb(side(near))} to ${nb(`+${compact.format(Math.abs(far))}`)}`; }
  return `${nb(side(lo))} to ${nb(side(hi))}`;
}
// The county shift is partisan, so it uses the diverging palette chosen in Colors, centered on no shift.
const mapTheme = () => mapBasics().theme;
const shiftColor = v => palRamp('partisan', mapTheme())(partisanT(v, 0, SHIFT_MAX));
const counties = () => st.live?.counties || [];
// Final mode: every county has reported all its precincts. Live mode stays as it was for any other night.
const isFinal = () => st.live?.statewide?.counties_complete === COUNTIES;
// Raw counts by vote type, used only when they describe the same snapshot as live.json.
const observed = () => st.observed?.snapshot_utc === st.live?.statewide?.snapshot_utc ? st.observed : null;
// An 80% range is shown only when its ends differ at the precision displayed.
const rangeShown = (lo, hi, fmt) => Number.isFinite(lo) && Number.isFinite(hi) && fmt(lo) !== fmt(hi);
const byId = () => new Map(counties().map(c => [c.fips3, c]));

// ---- Loading ----
async function refresh() {
  try {
    const [live, traj] = await Promise.all([fetchJSON('live.json'), fetchJSON('trajectory.json').catch(() => [])]);
    st.live = live; st.traj = Array.isArray(traj) ? traj : []; st.loadedAt = new Date(); st.error = null;
    st.observed = isFinal() ? await fetchJSON('observed.json').catch(() => null) : null;
    if (isFinal()) { resultsOK ??= await resultsAvailable(); forecast ??= await loadForecast().catch(() => null); }
  } catch (error) { st.error = error; }
  render();
}
function render() {
  // Final returns do not change during the night, so the page stops checking for new ones.
  if (isFinal()) { clearInterval(timer); timer = null; }
  const results = isFinal() && !!resultsOK;
  tab.classList.toggle('eday-final', isFinal());
  tab.classList.toggle('eday-results', results);
  renderStatus(); syncTopbar();
  if (!st.live) return;
  $('#eday-traj-title').textContent = isFinal() ? 'How the count unfolded' : 'Through the night';
  renderSummary(); drawTrajectory();
  if (results) { renderForecastVsResult(); activateResults(st.active); return; }
  if (!map) initMap();
  paintMap(); renderLegend(); drawTable();
}
// Pre-election figures for the forecast-vs-result card: the published combined estimate, and the county expected votes summed.
async function loadForecast() {
  const [headline, store] = await Promise.all([csv('headline.csv'), ensureStore('county')]);
  const combined = headline.find(row => row.component === 'combined');
  let margin = 0;
  for (let i = 0; i < store.n; i++) margin += store.tal[i] - store.pax[i];
  return { share:combined ? +combined.mean : NaN, margin };
}
function renderForecastVsResult() {
  const s = st.live.statewide, f = forecast, host = $('#eday-fvr');
  if (!f || !Number.isFinite(f.share)) { host.innerHTML = ''; return; }
  const gap = s.tal_2p_mean - f.share, mgap = s.margin_mean - f.margin;
  const row = (label, a, b, d) => `<div class="fvr-row"><span class="fvr-label">${escapeHTML(label)}</span><span>${a}</span><span>${b}</span><strong>${d}</strong></div>`;
  host.innerHTML = `<h4>Forecast and result</h4><div class="fvr-grid"><div class="fvr-row fvr-head"><span></span><span>Pre-election forecast</span><span>Result</span><span>Gap</span></div>
    ${row('Talarico two-party share', escapeHTML(share(f.share)), escapeHTML(share(s.tal_2p_mean)), escapeHTML(pts(gap)))}
    ${row('Margin', escapeHTML(marginText(f.margin)), escapeHTML(marginText(s.margin_mean)), escapeHTML(`${mgap >= 0 ? '+' : '−'}${count(Math.abs(mgap))} votes`))}</div>
    <p class="note">The forecast is the model’s combined pre-election estimate; its margin sums the county expected votes. The result is unofficial.</p>`;
}
// The top bar keeps the published pre-results forecast. On this tab it is labelled as such, and with final returns the
// result leads and the forecast becomes a smaller secondary label.
function syncTopbar() {
  const bar = document.querySelector('.topstats'), final = st.active && isFinal(), s = st.live?.statewide;
  document.querySelector('#ts-pre').hidden = !st.active;
  document.querySelector('#ts-pre').textContent = final ? 'Pre-election forecast' : 'Pre-results';
  const result = document.querySelector('#ts-final');
  result.hidden = !final;
  if (final) result.innerHTML = `Talarico <strong>${escapeHTML(share(s.tal_2p_mean))}</strong> <span class="ts-sep">·</span> margin <strong>${Number.isFinite(s.margin_mean) ? `${s.margin_mean >= 0 ? '+' : '−'}${count(Math.abs(s.margin_mean))}` : 'n/a'}</strong> <span class="ts-note">unofficial, canvass pending</span>`;
  bar.classList.toggle('is-final', final);
  bar.setAttribute('aria-label', final ? 'Unofficial result, then the pre-results statewide forecast' : st.active ? 'Pre-results statewide forecast' : 'Statewide forecast');
}
function renderStatus() {
  const banner = $('#eday-banner');
  banner.hidden = !rehearsal;
  if (rehearsal) banner.textContent = 'Rehearsal: these are simulated returns, not real results.';
  const s = st.live?.statewide;
  $('#eday-status').textContent = st.error && !st.live ? `Election-night results are not available: ${st.error.message}`
    : s && isFinal() ? `Final unofficial returns as of ${centralFull(s.snapshot_utc)}.`
    : s ? `Returns as of: ${centralFull(s.snapshot_utc)}. ${count(s.counties_reporting)} of ${count(counties().length)} counties reporting, ${count(s.counties_complete)} complete. Page last checked: ${centralClock(st.loadedAt)}; this page checks again every ${POLL_MS / 1000} seconds. The estimate uses ${count(s.update_rows)} county updates${s.robust_sd > 0 ? ` and allows ±${(100 * s.robust_sd).toFixed(1)} pts of extra statewide shift` : ''}.`
    : 'Loading election-night results…';
}
function renderSummary() {
  const s = st.live.statewide;
  const stat = (label, value, note, html = false, cls = '') => `<div class="evt-stat${cls ? ` ${cls}` : ''}"><span>${escapeHTML(label)}</span><strong>${value}</strong><em>${html ? note : escapeHTML(note)}</em></div>`;
  if (isFinal()) { $('#eday-summary').innerHTML = finalSummary(s, stat); return; }
  $('#eday-summary').innerHTML = [
    stat('Chance Talarico wins', probPct(s.p_talarico), `Pre-results forecast: ${probPct(s.p_talarico_prior)}`),
    stat('Talarico two-party share', share(s.tal_2p_mean), `80% range ${share(s.tal_2p_q10)} to ${share(s.tal_2p_q90)}`),
    stat('Margin', escapeHTML(marginText(s.margin_mean)), `80% range: ${marginRange(s.margin_q10, s.margin_q90)}`, true),
    stat('Votes counted', count(s.votes_counted), `of about ${count(s.votes_expected)} expected (${pct(s.pct_counted, 0)})`),
    stat('Counties', `${count(s.counties_reporting)} reporting`, `${count(s.counties_complete)} of ${count(counties().length)} complete`),
    stat('Election Day turnout vs. expected', Number.isFinite(s.eday_turnout_factor) ? `${s.eday_turnout_factor.toFixed(2)}×` : 'n/a', 'From fully reported counties'),
    stat('Early minus Election Day', pts(s.early_gap_mean), `Talarico share gap, ± ${Number.isFinite(s.early_gap_sd) ? (100 * s.early_gap_sd).toFixed(1) : 'n/a'} pts`),
  ].join('');
}

function finalSummary(s, stat) {
  const sharePlain = v => share(v), marginPlain = v => marginText(v);
  const o = observed(), gapSd = Number.isFinite(s.early_gap_sd) ? `, ± ${(100 * s.early_gap_sd).toFixed(1)} pts` : '';
  const raw = o ? ` Raw statewide shares: early ${share(o.early.dem_2p)}, Election Day + late ${share(o.eday_late.dem_2p)}. The raw gap is wider because it also reflects which counties the Election Day vote came from.` : '';
  return [
    stat('Talarico two-party share', share(s.tal_2p_mean), rangeShown(s.tal_2p_q10, s.tal_2p_q90, sharePlain) ? `80% range ${share(s.tal_2p_q10)} to ${share(s.tal_2p_q90)}` : 'Of the Talarico and Paxton vote'),
    stat('Margin', escapeHTML(marginText(s.margin_mean)), rangeShown(s.margin_q10, s.margin_q90, marginPlain) ? `80% range: ${marginRange(s.margin_q10, s.margin_q90)}` : 'Votes, Talarico minus Paxton', true),
    stat('Votes counted', count(s.votes_counted), 'All candidates'),
    stat('Counties', `${count(s.counties_complete)} complete`, `of ${count(COUNTIES)}`),
    stat('Election Day turnout vs. expected', Number.isFinite(s.eday_turnout_factor) ? `${s.eday_turnout_factor.toFixed(2)}×` : 'n/a', 'From fully reported counties'),
    stat('Early minus Election Day, within county', pts(s.early_gap_mean), `Model estimate of the Talarico share gap inside the same county${gapSd}.${raw}`, false, 'eday-gap'),
    `<p class="eday-final-note">These are unofficial returns. Provisional ballots, late military and overseas ballots, and the county canvass are still to come, so the counts can change.</p>`,
  ].join('');
}

// ---- Map: shift from the pre-results forecast, faded by how much of the county's expected vote is counted ----
function addLayers() {
  const b = mapBasics();
  // Fills, borders and highways go beneath the basemap's place labels, as on the Forecast map.
  const layers = map.getStyle().layers;
  let first = layers.length;
  while (first > 0 && layers[first - 1].type === 'symbol') first--;
  const below = layers[first]?.id;
  if (!map.getSource('eday-county')) map.addSource('eday-county', { type:'vector', url:b.tileURL(b.tiles.county), promoteId:'region_id' });
  map.addLayer({ id:'eday-fill', type:'fill', source:'eday-county', 'source-layer':'regions', paint:{ 'fill-color':'#cfd5d5', 'fill-opacity':.15 } }, below);
  map.addLayer({ id:'eday-line', type:'line', source:'eday-county', 'source-layer':'regions', paint:{ 'line-color':b.theme === 'dark' ? 'rgba(220,230,235,.35)' : 'rgba(40,55,60,.3)', 'line-width':.5 } }, below);
  b.highways(below, map);
  map.addLayer({ id:'eday-hi', type:'line', source:'eday-county', 'source-layer':'regions', filter:['in', ['to-string', ['get', 'region_id']], ['literal', []]], paint:{ 'line-color':b.theme === 'dark' ? '#ffffff' : '#111a1f', 'line-width':2.4 } }, below);
  // Some styles (OpenFreeMap Dark) put a water-label layer before their roads; lift it above the fills too.
  if (below) for (const layer of layers.slice(0, first)) if (layer.type === 'symbol') map.moveLayer(layer.id, below);
  b.labels(map);
  mapReady = true;
  paintMap();
  paintHighlight();
}
function paintMap() {
  if (!map || !mapReady || !map.getLayer('eday-fill')) return;
  const colors = {}, opacity = {};
  for (const c of counties()) {
    colors[c.fips3] = Number.isFinite(c.shift) ? shiftColor(c.shift) : '#cfd5d5';
    opacity[c.fips3] = .12 + .83 * Math.max(0, Math.min(1, Number.isFinite(c.pct_counted) ? c.pct_counted : 0));
  }
  const key = ['to-string', ['get', 'region_id']];
  map.setPaintProperty('eday-fill', 'fill-color', ['coalesce', ['get', key, ['literal', colors]], '#cfd5d5']);
  map.setPaintProperty('eday-fill', 'fill-opacity', ['coalesce', ['get', key, ['literal', opacity]], .12]);
  tipId = null;
}
// Hover and selection only move the outline layer's filter; the fill is never repainted for them.
function paintHighlight() {
  if (!map || !mapReady || !map.getLayer('eday-hi')) return;
  map.setFilter('eday-hi', ['in', ['to-string', ['get', 'region_id']], ['literal', [st.sel, st.hover].filter(Boolean)]]);
}
function renderLegend() {
  const half = Math.round(100 * partisanClamp(SHIFT_MAX)), mid = Math.round(100 * partisanCenter());
  $('#eday-legend').innerHTML = `<div class="eday-legend-title">Shift from the pre-results forecast</div><div class="eday-ramp" style="background:${gradient('partisan', mapTheme())}"></div>
    <div class="eday-legend-scale"><span>Paxton +${half - mid}</span><span>${mid ? `${mid > 0 ? '+' : '−'}${Math.abs(mid)}` : '0'}</span><span>Talarico +${half + mid}</span></div>
    <div class="eday-legend-note">Points of Talarico two-party share.${isFinal() ? '' : ' Fainter counties have less of their expected vote counted.'}</div>`;
  const title = $('#eday-legend .eday-legend-title'); title.append(' ', swatchButton('partisan'));
}
function tooltipHTML(c) {
  if (!c) return '';
  const line = (k, v) => `${escapeHTML(k)}: ${v}`;
  if (isFinal()) return `<strong>${escapeHTML(titleCase(c.county))}</strong>${[
    line('Counted', `${count(c.counted_early)} early, ${count(c.counted_eday)} Election Day + late`),
    line('Talarico share, early', share(c.obs_2p_early)), line('Talarico share, Election Day + late', share(c.obs_2p_eday)),
    line('Pre-results forecast', share(c.prior_2p)), line('Result', share(c.post_2p)), line('Shift vs forecast', pts(c.shift)),
  ].join('<br>')}`;
  return `<strong>${escapeHTML(titleCase(c.county))}</strong>${[
    line('Counted', `${count(c.counted_early)} early, ${count(c.counted_eday)} Election Day (${pct(c.pct_counted, 0)} of expected)${c.complete ? ', complete' : ''}`),
    line('Talarico share, early', share(c.obs_2p_early)), line('Talarico share, Election Day', share(c.obs_2p_eday)),
    line('Pre-results forecast', share(c.prior_2p)), line('Estimate', `${share(c.post_2p)} ± ${Number.isFinite(c.post_2p_sd) ? (100 * c.post_2p_sd).toFixed(1) : 'n/a'} pts`),
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
  // The tab's map follows the basemap chosen in Map controls.
  window.addEventListener('basemap-change', () => { if (!map) return; mapReady = false; map.setStyle(mapBasics().style); });
  const wrap = tab.querySelector('.evt-map-wrap');
  let fitted = false;
  new ResizeObserver(() => { if (!wrap.clientWidth || !wrap.clientHeight) return; map.resize(); if (!fitted) { fitted = true; map.fitBounds(b.bounds, { padding:24, duration:0 }); } }).observe(wrap);
  const tip = $('#eday-tooltip');
  const place = point => {
    const box = map.getContainer().getBoundingClientRect();
    tip.style.left = `${point.x + 14 + tipSize.w > box.width ? Math.max(4, point.x - tipSize.w - 14) : point.x + 14}px`;
    tip.style.top = `${Math.max(6, Math.min(box.height - tipSize.h - 6, point.y - tipSize.h / 2))}px`;
  };
  // One feature query per frame; the tooltip text is rebuilt only when the hovered county changes.
  let point = null, frame = 0;
  map.on('mousemove', e => {
    point = e.point;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const f = mapReady && map.queryRenderedFeatures(point, { layers:['eday-fill'] })[0];
      map.getCanvas().style.cursor = f ? 'pointer' : '';
      const c = f && byId().get(String(f.properties.region_id));
      if (!c) { tip.hidden = true; tipId = null; setHover(null); return; }
      if (c.fips3 !== tipId) {
        tip.innerHTML = tooltipHTML(c); tip.hidden = false; tipId = c.fips3;
        tipSize = { w:tip.offsetWidth, h:tip.offsetHeight };
      }
      place(point);
      setHover(c.fips3);
    });
  });
  map.on('mouseout', () => { cancelAnimationFrame(frame); frame = 0; tip.hidden = true; tipId = null; setHover(null); });
  map.on('click', e => { const f = mapReady && map.queryRenderedFeatures(e.point, { layers:['eday-fill'] })[0]; setSelection(f ? String(f.properties.region_id) : null); });
}
function setHover(id) { if (st.hover === id) return; st.hover = id; paintHighlight(); markTable(); }
function setSelection(id) {
  st.sel = st.sel === id ? null : id; paintHighlight(); markTable();
  if (st.sel) tab.querySelector(`#eday-table tr[data-id="${st.sel}"]`)?.scrollIntoView({ block:'nearest' });
}

// ---- Trajectory: chance of winning, then the two-party share with its 80% range, against snapshot time ----
function drawTrajectory() {
  const host = $('#eday-traj'), tip = host.querySelector('.chart-tooltip');
  const rows = st.traj.filter(r => Number.isFinite(new Date(r.snapshot_utc).getTime()));
  const prior = st.live?.statewide?.p_talarico_prior;
  host.querySelector('svg')?.remove();
  const final = isFinal(), W = Math.max(280, host.clientWidth || 360), H1 = final ? 0 : 150, H2 = 170, gap = final ? 0 : 34, m = { l:40, r:12, t:16, b:22 }, H = H1 + gap + H2 + m.b + 12;
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
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${final ? 'Talarico two-party share as the count unfolded' : 'Chance Talarico wins and his two-party share through the night'}">
    ${final ? '' : `<text class="evt-axis label" x="${m.l}" y="${m.t - 5}">Chance Talarico wins</text>
    ${grid(y1, [0, .25, .5, .75, 1], v => `${Math.round(100 * v)}%`)}
    ${Number.isFinite(prior) ? `<line class="eday-prior" x1="${m.l}" x2="${W - m.r}" y1="${y1(prior)}" y2="${y1(prior)}"/><text class="evt-axis" x="${W - m.r}" y="${y1(prior) - 4}" text-anchor="end">Pre-results forecast ${probPct(prior)}</text>` : ''}
    <path class="eday-line p" d="${path(r => r.p_talarico, y1)}"/>
    ${xAxis(y1.range()[0])}`}
    <text class="evt-axis label" x="${m.l}" y="${top2 - 5}">Talarico two-party share, with 80% range</text>
    ${grid(y2, y2.ticks(4), v => `${(100 * v).toFixed(0)}%`)}
    ${.5 >= y2.domain()[0] && .5 <= y2.domain()[1] ? `<line class="evt-mid" x1="${m.l}" x2="${W - m.r}" y1="${y2(.5)}" y2="${y2(.5)}"/>` : ''}
    <path class="eday-band" d="${band}"/><path class="eday-line s" d="${path(r => r.tal_2p_mean, y2)}"/>
    ${final ? '' : `<circle class="eday-dot" cx="${x(t.at(-1))}" cy="${y1(rows.at(-1).p_talarico)}" r="3.5"/>`}<circle class="eday-dot" cx="${x(t.at(-1))}" cy="${y2(rows.at(-1).tal_2p_mean)}" r="3.5"/>
    ${xAxis(y2.range()[0])}
    <text class="evt-axis" x="${W - m.r}" y="${y2.range()[0] + 26}" text-anchor="end">Snapshot time, Central</text>
    <line class="eday-cross" x1="0" x2="0" y1="${m.t}" y2="${y2.range()[0]}" visibility="hidden"/>
    <rect class="evt-hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${y2.range()[0] - m.t}"/></svg>`;
  host.insertAdjacentHTML('afterbegin', svg);
  const el = host.querySelector('svg'), cross = el.querySelector('.eday-cross');
  el.querySelector('.evt-hit').addEventListener('pointermove', e => {
    const box = el.getBoundingClientRect(), px = (e.clientX - box.left) * W / box.width;
    let k = 0; for (let i = 1; i < t.length; i++) if (Math.abs(x(t[i]) - px) < Math.abs(x(t[k]) - px)) k = i;
    const r = rows[k], cx = x(t[k]);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    tip.innerHTML = `<strong>${escapeHTML(centralFull(r.snapshot_utc))}</strong>${final ? '' : `Chance Talarico wins: ${probPct(r.p_talarico)}<br>`}Two-party share: ${share(r.tal_2p_mean)} (${share(r.tal_2p_q10)} to ${share(r.tal_2p_q90)})<br>Margin: ${escapeHTML(marginText(r.margin_mean))}<br>Counted: ${count(r.votes_counted)} (${pct(r.pct_counted, 0)})<br>Counties complete: ${count(r.counties_complete)}`;
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
  { key:'prior_2p', label:'Pre-results forecast', show:c => share(c.prior_2p) },
  { key:'post_2p', label:'Estimate', show:c => share(c.post_2p) },
  { key:'shift', label:'Shift', show:c => pts(c.shift) },
  { key:'expected_total', label:'Expected votes', show:c => count(c.expected_total) },
];
// Final mode renames three columns and hides the two that only describe counting progress.
const finalLabels = { counted_eday:'Election Day + late', post_2p:'Result', shift:'Shift vs forecast' };
const finalHidden = new Set(['pct_counted', 'complete']);
function drawTable() {
  const final = isFinal();
  const cols = final ? columns.filter(c => !finalHidden.has(c.key)).map(c => finalLabels[c.key] ? { ...c, label:finalLabels[c.key] } : c) : columns;
  if (final && finalHidden.has(st.sort)) { st.sort = 'expected_total'; st.dir = -1; }
  const col = cols.find(c => c.key === st.sort) || cols.at(-1);
  const val = c => col.key === 'complete' ? +!!c.complete : c[col.key];
  const rows = [...counties()].sort((a, b) => {
    const p = val(a), q = val(b);
    return (col.text ? String(p).localeCompare(String(q)) : (Number.isFinite(p) ? p : -Infinity) - (Number.isFinite(q) ? q : -Infinity)) * st.dir;
  });
  $('#eday-table').innerHTML = `<div class="table-scroll evt-table"><table><thead><tr>${cols.map(c => `<th class="${c.text ? 'name' : ''}" aria-sort="${c.key === col.key ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${c.key}">${escapeHTML(c.label)}</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(c => `<tr data-id="${escapeHTML(c.fips3)}" tabindex="0">${cols.map(k => `<td class="${k.text ? 'name' : ''}">${k.show(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">${final ? "Shares are Talarico's share of the two-party vote. Election Day + late is every vote not cast early, including ballots counted after Election Day. The result is the county's counted share; shift vs forecast is the result minus the pre-results forecast." : "Shares are Talarico's share of the two-party vote. Early and Election Day shares are the counted votes so far; the estimate is the updated county share. A dash means no votes of that kind are counted yet."}</p>`;
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
    $('#eday-table').addEventListener('click', e => {
      const sort = e.target.closest('[data-sort]'), tr = e.target.closest('tr[data-id]');
      if (sort) { const key = sort.dataset.sort; if (st.sort === key) st.dir = -st.dir; else { st.sort = key; st.dir = columns.find(c => c.key === key).text ? 1 : -1; } drawTable(); }
      else if (tr) setSelection(tr.dataset.id);
    });
    $('#eday-table').addEventListener('pointerover', e => { const tr = e.target.closest('tr[data-id]'); setHover(tr ? tr.dataset.id : null); });
    $('#eday-table').addEventListener('pointerleave', () => setHover(null));
    new ResizeObserver(() => { if (!tab.hidden && st.live) drawTrajectory(); }).observe($('#eday-traj'));
    new MutationObserver(() => { if (!tab.hidden) { paintMap(); renderLegend(); } }).observe(document.documentElement, { attributes:true, attributeFilter:['data-layout'] });
  }
  refresh();
  clearInterval(timer); timer = null;
  if (!isFinal()) timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}
// Palette changes repaint the map and legend.
window.addEventListener('palette-change', () => { if (!tab.hidden && st.live) { paintMap(); renderLegend(); } });
window.addEventListener('view-tab', ({ detail }) => {
  const on = detail.view === 'eday';
  tab.hidden = !on; st.active = on;
  if (!on) activateResults(false);
  syncTopbar();
  const url = new URL(location.href);
  if (on) { url.searchParams.set('tab', 'eday'); start(); map?.resize(); if (tab.classList.contains('eday-results')) activateResults(true); }
  else { clearInterval(timer); timer = null; if (url.searchParams.get('tab') === 'eday') url.searchParams.delete('tab'); }
  history.replaceState(null, '', url);
});
// The tab button appears once the real estimate is published. A rehearsal is reachable only through ?tab=eday&src=rehearsal.
fetch(`${base}data/live/live.json?t=${Date.now()}`, { method:'HEAD', cache:'no-store' }).then(r => r.ok).catch(() => false).then(published => {
  const asked = params.get('tab') === 'eday';
  tabButton.hidden = !(published || asked);
  if (asked) showView('eday');
});
