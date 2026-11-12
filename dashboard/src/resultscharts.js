import { scaleLinear } from 'd3-scale';
import { interpolateLab } from 'd3-interpolate';
import { escapeHTML, count } from './data.js';
import { shareOf, tpOf, evaluate, metricArray, STATUS, indexOf as cmpIndexOf, levelInfo } from './compare.js';
import { loadDemographics, modelEntries, levelTable, createPicker, methodNote, MIN_UNITS, finiteCount, acsGroups } from './measures.js';
import { createXYPlot, colorLegend, weightedFit } from './xyplot.js';
import { shortLabel } from './labels.js';

// Scatter, distribution and "what tracks Y" ranking below the Results map (paint() calls `paint(c)` here right after
// drawTable, so c.drawn - the map's color scale - is already set). One "picked set" concept (a scatter brush or a
// histogram bin click) is shared between the three views and reported back to resultsmap.js, which owns the map
// outline and the table filter; nothing here touches the map or the table directly.
const $ = selector => document.querySelector(selector);
const RESULT_GROUP = '2026 result';
const rankGroups = [...acsGroups, 'Race and ethnicity', 'Model inputs', 'Politics'];
const EVAL_FILTER = { min:0, county:'', profile:'', fallback:false };

const st = {
  started:false, acs:null, model:null, catalog:[], usable:[], usableKey:'',
  table:null, perm:null, level:null,
  x:'hisp_cvap_share', y:'res_vs_forecast', c:'res_share', mode:'binned', sizeByWeight:true,
  pickers:null, plot:null,
  hoverId:null, selId:null, lastC:null, lastCtx:null,
  picked:null, pickedFrom:null, bins:null,
  rankAll:false, rankCache:new Map(), rankTimer:0,
  callbacks:{},
};

// ---- Formatting helpers for the "2026 result" group and its "Map: <measure>" entry ----
const canonicalMatch = (def, pair) => def.key === 'res_share' || def.key === 'res_votes' || def.key === 'fc_shift'
  || (def.pair === 'chosen' && def.metric === 'shift' && pair && ((pair.from === 'sen24' && pair.to === 'sen26') || (pair.from === 'pres24' && pair.to === 'sen26')));
const fmtUnitOf = { share:'share', pctshare:'share', shift:'points', diff:'count', votes:'count', income:'dollars' };

function resultEntries(store) {
  const tp26 = tpOf(store, 'sen26');
  const shift = (from, to) => () => metricArray(evaluate(store, from, to, EVAL_FILTER), 'shift');
  return [
    { key:'res_share', label:'Talarico share', group:RESULT_GROUP, unit:'share', partisan:true, type:'share', get:() => shareOf(store, 'sen26') },
    { key:'res_vs_forecast', label:'Result minus forecast', group:RESULT_GROUP, unit:'points', partisan:true, type:'shift', get:shift('f26', 'sen26') },
    { key:'res_vs_sen24', label:'Shift from 2024 Senate', group:RESULT_GROUP, unit:'points', partisan:true, type:'shift', get:shift('sen24', 'sen26') },
    { key:'res_vs_pres24', label:'Shift from 2024 President', group:RESULT_GROUP, unit:'points', partisan:true, type:'shift', get:shift('pres24', 'sen26') },
    { key:'res_pace', label:'2026 votes ÷ 2024 President votes', group:RESULT_GROUP, unit:'pace', type:'pace', get:() => { const p = tpOf(store, 'pres24'), out = new Float64Array(store.n); for (let i = 0; i < store.n; i++) out[i] = p[i] > 0 ? tp26[i] / p[i] : NaN; return out; } },
    { key:'res_votes', label:'2026 two-party votes', group:RESULT_GROUP, unit:'count', type:'count', get:() => tp26 },
  ];
}
// The map's own current measure, when it is not already one of the entries above.
function mapEntry(c) {
  const unit = fmtUnitOf[c.fmt] || null, out = new Float64Array(c.store.n).fill(NaN);
  for (let i = 0; i < c.store.n; i++) if (c.status[i] === STATUS.ok || c.status[i] === STATUS.countyFallback) out[i] = c.array[i];
  return { key:'rc_map_current', label:`Map: ${c.def.label}`, group:RESULT_GROUP, unit, partisan:isDivergingFmt(c.fmt), type:'other', get:() => out };
}
// Partisan (diverging, centered) only for shares and point shifts - never vote counts or a vote margin, which get the sequential ramp.
const isDivergingFmt = fmt => fmt === 'share' || fmt === 'shift';

function valuesOf(entry, store) {
  if (!entry) return null;
  if (entry.group === RESULT_GROUP) return entry.get();
  if (!st.table || st.table.level !== store.level) return null;
  const col = st.table.column(entry.key, entry.source);
  return Float64Array.from(st.perm, k => k < 0 ? NaN : col[k]);
}
const moeOf = entry => entry?.hasMoe && st.table ? valuesOf({ key:`${entry.key}_moe`, source:'details' }, { level:st.table.level }) : null;

async function ensureCatalog(c) {
  const store = c.store, level = store.level;
  if (!st.acs) { st.acs = await loadDemographics(); st.model = await modelEntries(); }
  if (st.level !== level || !st.table) {
    st.table = await levelTable(level).catch(() => null);
    st.perm = st.table ? Int32Array.from(store.ids, id => st.table.index.get(String(id)) ?? -1) : null;
    st.level = level; st.usableKey = '';
  }
  const base = [...resultEntries(store), ...(canonicalMatch(c.def, c.pair) ? [] : [mapEntry(c)]), ...(st.acs?.entries || []), ...st.model];
  st.catalog = base;
  const key = `${level}|${canonicalMatch(c.def, c.pair) ? '' : c.def.key}`;
  if (st.usableKey !== key) {
    st.usable = base.filter(e => { const v = valuesOf(e, store); return v && finiteCount(v) >= MIN_UNITS; });
    st.usableKey = key;
  }
}

// ---- Rows used: the map's places, excluding filtered ones, flat (no-precinct-returns) counties, and places below the vote floor ----
function usableMask(c) {
  const store = c.store, tp26 = tpOf(store, 'sen26'), min = Math.max(1, c.min || 0), nrSet = c.nr?.set;
  const keep = new Uint8Array(store.n);
  for (let i = 0; i < store.n; i++) {
    if (c.status[i] === STATUS.filtered) continue;
    if (nrSet && nrSet.has(store.county[i])) continue;
    if (!(tp26[i] >= min)) continue;
    keep[i] = 1;
  }
  return keep;
}
const masked = (raw, keep) => Float64Array.from(raw, (v, i) => keep[i] ? v : NaN);

// ---- Presets ----
const presets = { hisp:['hisp_cvap_share', 'res_vs_sen24'], harris:['base_pres24', 'res_share'], income:['median_hh_income', 'res_vs_forecast'], college:['pct_ba_plus', 'res_vs_sen24'] };

// ---- Scatter ----
function entryOf(key) { return st.catalog.find(e => e.key === key) || null; }
function drawScatter(c, keep) {
  const store = c.store, noun = levelInfo[store.level].noun;
  st.x = st.pickers.x.set(st.usable, st.usable.some(e => e.key === st.x) ? st.x : 'hisp_cvap_share');
  st.y = st.pickers.y.set(st.usable, st.usable.some(e => e.key === st.y) ? st.y : 'res_vs_forecast');
  st.c = st.pickers.c.set(st.usable, st.usable.some(e => e.key === st.c) ? st.c : 'res_share');
  const xm = entryOf(st.x), ym = entryOf(st.y), cm = entryOf(st.c);
  const xs = xm ? masked(valuesOf(xm, store), keep) : null, ys = ym ? masked(valuesOf(ym, store), keep) : null, cs = cm ? valuesOf(cm, store) : null;
  const w = tpOf(store, 'sen26');
  const labels = Array.from({ length:store.n }, (_, i) => shortLabel(store.level, store.labels[i], undefined, { keepCounty:true }));
  const hoverIdx = st.hoverId ? cmpIndexOf(store, st.hoverId) : undefined, selIdx = st.selId ? cmpIndexOf(store, st.selId) : undefined;
  const marked = [hoverIdx, selIdx].filter(i => i !== undefined);
  const brushed = st.picked ? [...st.picked].map(id => cmpIndexOf(store, id)).filter(i => i !== undefined) : [];
  st.plot.draw({
    n:store.n, labels, x:xs, y:ys, c:cs, w, xm, ym, cm, xMoe:moeOf(xm), yMoe:moeOf(ym), cMoe:moeOf(cm),
    mode:st.mode, sizeByWeight:st.sizeByWeight, noun, yRef:ym?.unit === 'pace' ? 1 : ym?.unit === 'points' ? 0 : null,
    height:Math.round(Math.min(Math.max(($('#rc-plot')?.clientWidth || 320) * .62, 240), 400)), marked, brushed,
    onStats:stats => {
      $('#rc-stats').textContent = `${stats.n.toLocaleString('en-US')} ${noun}${stats.slopeText ? ` · ${stats.slopeText}` : stats.n < 30 ? ' · too few for a fit' : ''}${st.mode === 'points' && st.plot.state?.shown < stats.n ? ` · ${st.plot.state.shown.toLocaleString('en-US')} drawn` : ''}`;
      $('#rc-legend').innerHTML = colorLegend(cm, stats.colorRange);
    },
  });
  for (const b of document.querySelectorAll('#rc-scatter-card [data-rc-mode]')) b.setAttribute('aria-pressed', String(b.dataset.rcMode === st.mode));
  for (const b of document.querySelectorAll('#rc-presets [data-rc-preset]')) {
    const [px, py] = presets[b.dataset.rcPreset], keys = new Set(st.usable.map(e => e.key));
    b.disabled = !keys.has(px) || !keys.has(py);
    b.setAttribute('aria-pressed', String(st.x === px && st.y === py));
  }
  $('#rc-method').textContent = st.acs ? methodNote(st.acs) : '';
  $('#rc-method').hidden = !st.acs;
}

// ---- Distribution (SVG) ----
function colorScaleOf(drawn) { return scaleLinear().domain(drawn.stops).range(drawn.colors).interpolate(interpolateLab).clamp(true); }
function buildBins(c, keep) {
  const store = c.store, tp26 = tpOf(store, 'sen26'), n = 36;
  const rows = [];
  for (let i = 0; i < store.n; i++) if (keep[i] && c.status[i] === STATUS.ok && Number.isFinite(c.array[i])) rows.push(i);
  if (!rows.length) return { rows, bins:[], lo:0, hi:1, totalVotes:0, mean:NaN };
  let lo = Infinity, hi = -Infinity, totalVotes = 0, wsum = 0;
  for (const i of rows) { lo = Math.min(lo, c.array[i]); hi = Math.max(hi, c.array[i]); totalVotes += tp26[i]; wsum += tp26[i] * c.array[i]; }
  if (!(hi > lo)) hi = lo + 1;
  const width = (hi - lo) / n, bins = Array.from({ length:n }, (_, k) => ({ x0:lo + k * width, x1:lo + (k + 1) * width, votes:0, rows:[] }));
  for (const i of rows) { const k = Math.min(n - 1, Math.max(0, Math.floor((c.array[i] - lo) / width))); bins[k].votes += tp26[i]; bins[k].rows.push(i); }
  return { rows, bins, lo, hi, totalVotes, mean:totalVotes > 0 ? wsum / totalVotes : NaN };
}
function drawHistogram(c) {
  const host = $('#rc-dist');
  if (!host) return;
  const keep = usableMask(c);
  st.bins = buildBins(c, keep);
  const { bins, lo, hi, totalVotes, mean } = st.bins;
  const W = Math.max(240, host.clientWidth || 320), H = 170, m = { l:34, r:10, t:10, b:26 };
  const X0 = m.l, X1 = W - m.r, Y0 = H - m.b, Y1 = m.t;
  const sx = v => X0 + (v - lo) / (hi - lo) * (X1 - X0);
  if (!bins.length) { host.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="rc-dist-empty">No places with this measure at this level.</text></svg>`; return; }
  const maxShare = Math.max(...bins.map(b => totalVotes > 0 ? b.votes / totalVotes : 0), 1e-6);
  const barW = (X1 - X0) / bins.length;
  const scale = colorScaleOf(c.drawn);
  const pickedCounts = bins.map(b => st.picked ? b.rows.filter(i => st.picked.has(c.store.ids[i])).length : -1);
  const bars = bins.map((b, k) => {
    const share = totalVotes > 0 ? b.votes / totalVotes : 0, h = (Y0 - Y1) * (share / maxShare), color = scale((b.x0 + b.x1) / 2);
    const dim = st.picked && pickedCounts[k] === 0;
    return `<rect class="rc-dist-bar${dim ? ' dim' : ''}" data-bin="${k}" x="${(X0 + k * barW).toFixed(1)}" y="${(Y0 - h).toFixed(1)}" width="${Math.max(0, barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"></rect>`;
  }).join('');
  const strip = bins.map((b, k) => `<rect x="${(X0 + k * barW).toFixed(1)}" y="${(Y0 + 4).toFixed(1)}" width="${Math.max(0, barW - .4).toFixed(1)}" height="5" fill="${scale((b.x0 + b.x1) / 2)}"></rect>`).join('');
  const center = c.drawn.diverging ? c.drawn.center : null;
  const xFmt = v => fmtAxis(c, v);
  const meanX = Number.isFinite(mean) ? sx(mean) : null;
  const centerX = Number.isFinite(center) && center >= lo && center <= hi ? sx(center) : null;
  const pinId = st.selId || st.hoverId;
  const pinAt = pinId ? cmpIndexOf(c.store, pinId) : undefined;
  const pinX = pinAt !== undefined && Number.isFinite(c.array[pinAt]) ? sx(Math.max(lo, Math.min(hi, c.array[pinAt]))) : null;
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of ${escapeHTML(c.def.label)}, weighted by 2026 two-party votes">
    ${bars}${strip}
    ${centerX != null ? `<line class="rc-dist-center" x1="${centerX.toFixed(1)}" x2="${centerX.toFixed(1)}" y1="${Y1}" y2="${Y0}"></line>` : ''}
    ${meanX != null ? `<line class="rc-dist-mean" x1="${meanX.toFixed(1)}" x2="${meanX.toFixed(1)}" y1="${Y1}" y2="${Y0}"></line><text class="rc-dist-mean-label" x="${meanX.toFixed(1)}" y="${Y1 + 9}" text-anchor="middle">Mean of places shown</text>` : ''}
    <text class="rc-dist-axis" x="${X0}" y="${H - 4}" text-anchor="start">${escapeHTML(xFmt(lo))}</text>
    <text class="rc-dist-axis" x="${X1}" y="${H - 4}" text-anchor="end">${escapeHTML(xFmt(hi))}</text>
    ${pinX != null ? `<polygon class="rc-dist-pin" points="${pinX.toFixed(1)},${Y0 + 11} ${(pinX - 4).toFixed(1)},${Y0 + 18} ${(pinX + 4).toFixed(1)},${Y0 + 18}"></polygon>` : ''}
  </svg>`;
  wireHistogram(host, c);
}
// Reuses the map's own value formatter (fmtOf keys live in resultsmap.js); kept minimal here since this is only axis-edge text.
function fmtAxis(c, v) {
  switch (c.fmt) {
    case 'share': case 'pctshare': return `${Math.round(100 * v)}%`;
    case 'shift': return `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(100 * v))}`;
    case 'votes': return count(v);
    case 'income': return `$${count(v)}`;
    default: return String(+v.toFixed(2));
  }
}
function wireHistogram(host, c) {
  const svg = host.querySelector('svg'), tip = host.querySelector('.chart-tooltip') || host.appendChild(Object.assign(document.createElement('div'), { className:'chart-tooltip' }));
  tip.hidden = true;
  const { bins, totalVotes } = st.bins;
  svg.addEventListener('pointermove', event => {
    const rect = event.target.closest('[data-bin]');
    if (!rect) { tip.hidden = true; return; }
    const b = bins[+rect.dataset.bin], share = totalVotes > 0 ? b.votes / totalVotes : 0;
    tip.innerHTML = `<strong>${escapeHTML(fmtAxis(c, b.x0))} to ${escapeHTML(fmtAxis(c, b.x1))}</strong>${b.rows.length.toLocaleString('en-US')} places<br>${count(b.votes)} votes (${(100 * share).toFixed(1)}%)`;
    tip.hidden = false;
    const box = host.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
    tip.style.left = `${Math.min(x + 10, host.clientWidth - tip.offsetWidth - 4)}px`; tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
  svg.addEventListener('click', event => {
    const rect = event.target.closest('[data-bin]');
    if (!rect) return;
    const b = bins[+rect.dataset.bin], ids = b.rows.map(i => c.store.ids[i]);
    if (st.pickedFrom === 'hist' && st.picked && ids.length === st.picked.size && ids.every(id => st.picked.has(id))) setPicked(null, null);
    else setPicked(new Set(ids), 'hist');
  });
}

// ---- Ranking ----
function rankCacheKey(c, county) { return `${c.store.level}|${st.y}|${c.min}|${county || ''}`; }
function scheduleRank(c, county) {
  clearTimeout(st.rankTimer);
  st.rankTimer = setTimeout(() => computeRank(c, county), 0);
}
function computeRank(c, county) {
  const box = $('#rc-rank-card');
  if (!box) return;
  const ym = entryOf(st.y);
  if (!ym) { box.hidden = true; return; }
  box.hidden = false;
  $('#rc-rank-title').textContent = `What tracks ${ym.label.charAt(0).toLowerCase()}${ym.label.slice(1)}`;
  const key = rankCacheKey(c, county);
  if (!st.rankCache.has(key)) {
    const store = c.store, keep = usableMask(c), y = masked(valuesOf(ym, store), keep), w = tpOf(store, 'sen26');
    const idx = []; for (let i = 0; i < store.n; i++) if (keep[i] && Number.isFinite(y[i])) idx.push(i);
    const rows = [];
    for (const e of st.catalog) {
      if (e.type === 'count' || e.key === ym.key || !rankGroups.includes(e.group)) continue;
      const x = masked(valuesOf(e, store), keep), xi = [];
      for (const i of idx) if (Number.isFinite(x[i])) xi.push(i);
      if (xi.length < MIN_UNITS) continue;
      const fitted = weightedFit(x, y, w, xi);
      if (fitted) rows.push({ e, r:fitted.r, n:xi.length });
    }
    rows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    st.rankCache.set(key, rows);
    if (st.rankCache.size > 40) st.rankCache.delete(st.rankCache.keys().next().value);
  }
  const rows = st.rankCache.get(key), shown = st.rankAll ? rows : rows.slice(0, 12);
  const usableKeys = new Set(st.usable.map(e => e.key));
  $('#rc-rank-note').textContent = `Vote-weighted correlation across ${levelInfo[c.store.level].noun} between each measure and ${ym.label.charAt(0).toLowerCase()}${ym.label.slice(1)}, weighted by 2026 two-party votes. Measures with fewer than ${MIN_UNITS} places holding both values are left out. Click a row to put that measure on the X axis.`;
  $('#rc-rank-list').innerHTML = shown.map(({ e, r, n }) => {
    const wpct = Math.abs(r) * 50;
    return `<li><button type="button" class="sh-rank-row rc-rank-row${e.key === st.x ? ' current' : ''}" data-key="${escapeHTML(e.key)}" ${usableKeys.has(e.key) ? '' : 'disabled title="Not available at this level"'} aria-label="${escapeHTML(`${e.label} (${e.group}): r = ${r.toFixed(2)}, ${n.toLocaleString('en-US')} ${levelInfo[c.store.level].noun}`)}">
      <span class="sh-rank-label">${escapeHTML(e.label)}<em>${escapeHTML(e.group)}</em></span>
      <span class="sh-rank-bar"><i class="rc-rank-fill" style="${r >= 0 ? 'left:50%' : 'right:50%'};width:${wpct}%"></i></span>
      <span class="sh-rank-r">${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}</span></button></li>`;
  }).join('') || '<li class="note">No measure has enough places with values.</li>';
  $('#rc-rank-more').hidden = rows.length <= 12;
  $('#rc-rank-more').textContent = st.rankAll ? 'Show top 12' : `Show all ${rows.length}`;
}

// ---- Picked set (brush or histogram bin) ----
function setPicked(ids, from) {
  st.picked = ids && ids.size ? ids : null;
  st.pickedFrom = st.picked ? from : null;
  if (st.lastC) drawHistogram(st.lastC);
  if (st.plot?.state) { st.plot.state.brushed = st.picked ? [...st.picked].map(id => cmpIndexOf(st.lastC.store, id)).filter(i => i !== undefined) : []; st.plot.redraw(); }
  st.callbacks.onPicked?.(st.picked);
}
export function clearPicked() { setPicked(null, null); }
export function resetPicked() { setPicked(null, null); }

// ---- Public: mount, paint, lightweight mark update ----
export function mount(callbacks) {
  if (st.started) return;
  st.started = true;
  st.callbacks = callbacks;
  st.pickers = {
    x:createPicker($('#rc-x'), { label:'X', first:[RESULT_GROUP], onChange:v => { st.x = v; redraw(); } }),
    y:createPicker($('#rc-y'), { label:'Y', first:[RESULT_GROUP], onChange:v => { st.y = v; redraw(); } }),
    c:createPicker($('#rc-c'), { label:'Colour', first:[RESULT_GROUP], onChange:v => { st.c = v; redraw(); } }),
  };
  st.plot = createXYPlot($('#rc-plot'), {
    onPick:i => { const id = st.lastC?.store.ids[i]; if (id) callbacks.onPick?.(id); },
    onHover:i => { const id = i == null ? null : st.lastC?.store.ids[i]; callbacks.onHover?.(id ?? null); },
    onBrush:idx => { const store = st.lastC?.store; if (!store) return; setPicked(new Set(idx.map(i => store.ids[i])), 'scatter'); },
  });
  for (const b of document.querySelectorAll('#rc-scatter-card [data-rc-mode]')) b.addEventListener('click', () => { st.mode = b.dataset.rcMode; redraw(); });
  $('#rc-size')?.addEventListener('change', e => { st.sizeByWeight = e.target.checked; redraw(); });
  for (const b of document.querySelectorAll('#rc-presets [data-rc-preset]')) b.addEventListener('click', () => {
    if (b.disabled) return;
    const [px, py] = presets[b.dataset.rcPreset]; st.x = px; st.y = py; redraw();
  });
  $('#rc-rank-more')?.addEventListener('click', () => { st.rankAll = !st.rankAll; if (st.lastC) computeRank(st.lastC, st.lastCtx?.county); });
  $('#rc-rank-list')?.addEventListener('click', e => { const b = e.target.closest('[data-key]'); if (b && !b.disabled) { st.x = b.dataset.key; redraw(); } });
  new ResizeObserver(() => { if (st.lastC) { st.plot?.redraw(); drawHistogram(st.lastC); } }).observe($('#rc-scatter-card'));
}
function redraw() {
  if (!st.lastC) return;
  const c = st.lastC, keep = usableMask(c);
  drawScatter(c, keep);
  drawHistogram(c);
  scheduleRank(c, st.lastCtx?.county);
}
// Called from resultsmap.js's paint(), right after drawTable (c.drawn is set by then).
export async function paint(c, ctx = {}) {
  st.lastC = c; st.lastCtx = ctx;
  await ensureCatalog(c);
  const keep = usableMask(c);
  drawScatter(c, keep);
  drawHistogram(c);
  scheduleRank(c, ctx.county);
}
// Hover/selection from the map or the table: redraw only the scatter ring and the histogram pin, never the table or the ranking.
export function setMark(hoverId, selId) {
  st.hoverId = hoverId; st.selId = selId;
  if (!st.lastC) return;
  if (st.plot?.state) {
    const store = st.lastC.store, hi = hoverId ? cmpIndexOf(store, hoverId) : undefined, si = selId ? cmpIndexOf(store, selId) : undefined;
    st.plot.state.marked = [hi, si].filter(i => i !== undefined);
    requestAnimationFrame(() => st.plot.redraw());
  }
  requestAnimationFrame(() => drawHistogram(st.lastC));
}
export const getPicked = () => st.picked;
export const getPickedFrom = () => st.pickedFrom;
