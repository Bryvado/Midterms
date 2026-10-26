import { scaleLinear } from 'd3-scale';
import { csv, pct, count, signed, escapeHTML } from './data.js';
import { state, setState, races, raceOf, metrics, profileNames, profileLabels, minOptions, levelInfo, ensureStore, evaluate, metricArray, STATUS, weightedMean, weightedFit, pairLabel, crossOffice, crossesSources, sourceCaveat, pastKeys, statewide, tpOf, shareOf } from './compare.js';
import { contours } from './contours.js';
import { selectPlace } from './details.js';
import { countyNames, shortLabel } from './labels.js';
import { viewBounds, shareColor, setBrush, setArea, startDraw, cancelDraw } from './map.js';
import { boxesFor } from './list.js';
import { acsGroups, loadDemographics, modelEntries, levelTable, finiteCount, MIN_UNITS, createPicker, methodNote } from './measures.js';
import { createXYPlot, colorLegend, weightedFit as xyFit } from './xyplot.js';

const panel = document.querySelector('#fp-shifts');
const $ = selector => panel.querySelector(selector);
const dark = () => document.documentElement.dataset.layout === 'dark';
const ink = () => dark() ? { text:'#e5edf2', muted:'#acbfcb', grid:'#364a5b', zero:'#8aa1b2', panel:'#1b2937', fit:'#f4d27a' } : { text:'#1b282d', muted:'#64767b', grid:'#e3e9e8', zero:'#8e9ea3', panel:'#ffffff', fit:'#8a5a00' };
const profileColors = () => dark() ? ['#e0b155', '#5fcbb0', '#b998dc', '#ff9a63'] : ['#b8892f', '#2f9a80', '#7b55a6', '#d9662a'];
const points = v => `${v >= 0 ? '+' : '−'}${Math.abs(100 * v).toFixed(1)} pts`;
let store = null, counties = new Map(), loading = null, checked = null, boxes = null, indexOf = null;
// Linked brushing with the map: a lasso selection, the place last clicked on the map, chart zoom, and spatial restrictions.
const link = { tool:'pick', sel:null, focus:-1, zoom:null, inView:false, area:null };
const zoomKey = () => [state.view, state.level, state.from, state.to, state.y2from, state.y2to, state.xrel, state.yrel, state.demog].join('|');
const inside = (x, y, ring) => { let hit = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit; } return hit; };
// Places pass when their bounding box meets the map view, and when the center of their bounding box falls inside the drawn area.
function restrict(idx) {
  if (!boxes || (!link.inView && !link.area)) return idx;
  const view = link.inView ? viewBounds() : null;
  return idx.filter(i => {
    const b = boxes[store.ids[i]];
    if (!b) return false;
    if (view && !(b[0] <= view[2] && b[2] >= view[0] && b[1] <= view[3] && b[3] >= view[1])) return false;
    return !link.area || inside((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, link.area);
  });
}
const domainFor = (xd, yd) => link.zoom?.key === zoomKey() ? [link.zoom.xd, link.zoom.yd] : [xd, yd];
function restrictText() {
  const parts = [];
  if (link.inView) parts.push('places in the map view');
  if (link.area) parts.push('places inside the drawn area');
  return parts.length ? ` Showing only ${parts.join(' and ')}.` : '';
}
function syncTools() {
  for (const button of panel.querySelectorAll('[data-sh-tool]')) button.setAttribute('aria-pressed', String(button.dataset.shTool === link.tool));
  $('#sh-tools').hidden = state.view === 'table';
  // The scatter engine brushes by dragging and has no pan or zoom, so those tools apply only to the shift-vs-shift view.
  for (const el of [panel.querySelector('#sh-tools .range-switch'), $('#sh-zoom-reset')]) el.style.display = state.view === 'demog' ? 'none' : '';
  $('#sh-zoom-reset').disabled = link.zoom?.key !== zoomKey();
  $('#sh-sel-clear').hidden = !link.sel;
  $('#sh-area-clear').hidden = !link.area;
  $('#sh-restrict').checked = link.inView;
  $('#sh-sel-status').textContent = link.sel ? `${link.sel.size.toLocaleString('en-US')} selected, highlighted on the map` : '';
}
function setSelection(set) {
  link.sel = set && set.size ? set : null;
  setBrush(store.level, link.sel ? [...link.sel].map(i => store.ids[i]) : null);
  redraw();
}
// Points drawn in a fixed order: unselected first and faded when a selection exists, then the selection, then the focused place.
function pointStyle(i, ctx, base) {
  if (!link.sel) { ctx.globalAlpha = base; return false; }
  const on = link.sel.has(i);
  ctx.globalAlpha = on ? .9 : .1;
  return on;
}
function drawFocus(ctx, hit) {
  if (link.focus < 0) return;
  const k = hit.idx.indexOf(link.focus);
  if (k < 0) return;
  const c = ink();
  ctx.globalAlpha = 1;
  for (const [color, width] of [[c.panel, 4.5], [c.text, 2]]) { ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.arc(hit.sx[k], hit.sy[k], 8, 0, 6.2832); ctx.stroke(); }
}

function raceOptions(select, value) { select.replaceChildren(...races.map(race => new Option(race.label, race.key, false, race.key === value))); }
function build() {
  for (const [id, key] of [['#sh-from', 'from'], ['#sh-to', 'to'], ['#sh-y2from', 'y2from'], ['#sh-y2to', 'y2to']]) raceOptions($(id), state[key]);
  $('#sh-level').replaceChildren(...Object.entries(levelInfo).map(([key, info]) => new Option(info.label, key, false, key === state.level)));
  $('#sh-min').replaceChildren(...minOptions.map(v => new Option(v.toLocaleString('en-US'), String(v), false, v === state.min)));
  $('#sh-profile').replaceChildren(new Option('All profiles', ''), ...profileNames.map(key => new Option(profileLabels[key], key, false, key === state.profile)));
}
function syncControls() {
  for (const [id, key] of [['#sh-from', 'from'], ['#sh-to', 'to'], ['#sh-y2from', 'y2from'], ['#sh-y2to', 'y2to'], ['#sh-level', 'level'], ['#sh-profile', 'profile'], ['#sh-color', 'color']]) $(id).value = state[key];
  $('#sh-min').value = String(state.min);
  $('#sh-weight').value = state.weighted ? '1' : '0';
  $('#sh-xrel').checked = state.xrel; $('#sh-yrel').checked = state.yrel; $('#sh-contours').checked = state.contours;
  $('#sh-county').value = state.county ? counties.get(state.county) || state.county : '';
  for (const button of panel.querySelectorAll('[data-sh-view]')) button.setAttribute('aria-pressed', String(button.dataset.shView === state.view));
  for (const name of ['xy', 'demog', 'table']) $(`#sh-view-${name}`).hidden = state.view !== name;
  $('#sh-demog-rel').checked = state.xrel;
}

// ---- Shared text: counts, caveats, summary strip, footer check ----
function weightingText() { return state.weighted ? `Weighted by two-party votes in ${raceOf(state.from).label}` : 'Unweighted'; }
function renderHeader(ev, nounText) {
  const c = ev.counts, f = n => n.toLocaleString('en-US');
  $('#sh-counts').textContent = `${f(c.shown)} ${nounText} shown · ${f(c.below)} below minimum · ${f(c.missing)} missing a race${c.filtered ? ` · ${f(c.filtered)} excluded by filters` : ''}. ${weightingText()}.`;
  const lines = [];
  const add = (from, to, prefix) => {
    const tag = prefix ? `${prefix}: ` : '';
    if (crossOffice(from, to)) lines.push(`${tag}Cross-office comparison, so the shift includes candidate differences, not only changes in the electorate.`);
    if (crossesSources(from, to)) lines.push(`${tag}${sourceCaveat}`);
  };
  add(state.from, state.to, state.view === 'xy' ? 'X axis' : '');
  if (state.view === 'xy') add(state.y2from, state.y2to, 'Y axis');
  $('#sh-caveats').innerHTML = [...new Set(lines)].map(text => `<span>${escapeHTML(text)}</span>`).join('');
}
function renderSummary(ev) {
  const cells = [`<div class="sh-stat"><span>Statewide shift</span><strong>${Number.isFinite(ev.stateShift) ? points(ev.stateShift) : 'n/a'}</strong><em>all ${store.n.toLocaleString('en-US')} ${levelInfo[store.level].noun}, from vote totals</em></div>`];
  if (store.level === 'precinct') {
    const weights = state.weighted ? tpOf(store, state.from) : null;
    for (let k = 0; k < profileNames.length; k++) {
      const idx = [];
      for (let i = 0; i < store.n; i++) if (ev.status[i] === STATUS.ok && store.profile[i] === k) idx.push(i);
      const mean = weightedMean(ev.shift, weights, idx);
      cells.push(`<div class="sh-stat"><span>${profileLabels[profileNames[k]]}</span><strong>${idx.length ? points(mean) : '—'}</strong><em>${idx.length.toLocaleString('en-US')} ${idx.length === 1 ? 'precinct' : 'precincts'}</em></div>`);
    }
  }
  $('#sh-summary').innerHTML = cells.join('');
}
async function reconcile() {
  if (checked) return checked;
  checked = (async () => {
    const [precincts, shifts] = await Promise.all([ensureStore('precinct'), csv('uniform_shift.csv')]);
    const published = new Map(shifts.filter(row => row.component === 'combined').map(row => [row.baseline, +row.baseline_2p]));
    const failed = [];
    for (const key of pastKeys) {
      const got = statewide(precincts, key).share, want = published.get(key);
      if (!Number.isFinite(want) || !(Math.abs(got - want) <= 1e-4)) failed.push(`${raceOf(key).label} (precinct file ${Number.isFinite(got) ? pct(got, 3) : 'n/a'}, uniform_shift.csv ${Number.isFinite(want) ? pct(want, 3) : 'missing'})`);
    }
    return { failed, total:pastKeys.length };
  })().catch(error => { checked = null; throw error; });
  return checked;
}
async function renderCheck() {
  const box = $('#sh-check');
  try {
    const { failed, total } = await reconcile();
    box.classList.toggle('warn', failed.length > 0);
    box.textContent = failed.length ? `Warning: statewide share from the precinct file does not match uniform_shift.csv within 0.0001 for ${failed.join('; ')}.` : `Statewide check passed: all ${total} past races match uniform_shift.csv within 0.0001.`;
  } catch (error) { box.classList.add('warn'); box.textContent = `Statewide check could not run: ${error.message}`; }
}

// ---- Canvas helpers ----
function setup(canvas, aspect = .82) {
  const wrap = canvas.parentElement, width = Math.max(240, wrap.clientWidth), height = Math.round(Math.min(Math.max(width * aspect, 240), 460));
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
function domainOf(values, { zero = false, lowQ = .005, highQ = .995 } = {}) {
  const sorted = Float64Array.from(values).sort();
  let lo = quantile(sorted, lowQ), hi = quantile(sorted, highQ);
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const pad = Math.max((hi - lo) * .04, 1e-6);
  return [lo - pad, hi + pad];
}
function logTicks(lo, hi) {
  const out = [];
  for (let p = Math.pow(10, Math.floor(Math.log10(lo))); p <= hi * 1.001; p *= 10) for (const m of [1, 2, 5]) if (p * m >= lo && p * m <= hi) out.push(p * m);
  return out;
}
function drawFrame(ctx, plot, spec) {
  const c = ink();
  ctx.font = "10px 'DM Sans', system-ui, sans-serif";
  ctx.lineWidth = 1;
  for (const t of spec.xTicks) { const x = plot.px(t); ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(x, plot.top); ctx.lineTo(x, plot.bottom); ctx.stroke(); ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.fillText(spec.xFormat(t), x, plot.bottom + 13); }
  for (const t of spec.yTicks) { const y = plot.py(t); ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke(); ctx.fillStyle = c.muted; ctx.textAlign = 'right'; ctx.fillText(spec.yFormat(t), plot.left - 5, y + 3); }
  if (spec.zeroX !== undefined && spec.zeroX >= plot.x0 && spec.zeroX <= plot.x1) { ctx.strokeStyle = c.zero; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(plot.px(spec.zeroX), plot.top); ctx.lineTo(plot.px(spec.zeroX), plot.bottom); ctx.stroke(); ctx.setLineDash([]); }
  if (spec.zeroY !== undefined && spec.zeroY >= plot.y0 && spec.zeroY <= plot.y1) { ctx.strokeStyle = c.zero; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(plot.left, plot.py(spec.zeroY)); ctx.lineTo(plot.right, plot.py(spec.zeroY)); ctx.stroke(); ctx.setLineDash([]); }
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.strokeRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.fillStyle = c.muted; ctx.font = "600 10px 'DM Sans', system-ui, sans-serif"; ctx.textAlign = 'center';
  ctx.fillText(spec.xLabel, (plot.left + plot.right) / 2, plot.height - 4);
  // Shrink the rotated label to fit the plot height rather than letting it run off the canvas.
  const avail = plot.bottom - plot.top; let size = 10; ctx.font = `600 ${size}px 'DM Sans', system-ui, sans-serif`;
  while (ctx.measureText(spec.yLabel).width > avail && size > 7) { size -= .5; ctx.font = `600 ${size}px 'DM Sans', system-ui, sans-serif`; }
  ctx.save(); ctx.translate(11, (plot.top + plot.bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(spec.yLabel, 0, 0); ctx.restore();
}
function makePlot(width, height, xd, yd, xScale = x => x, yScale = y => y) {
  const left = width < 360 ? 44 : 50, right = width - 10, top = 8, bottom = height - 34;
  const x0 = xd[0], x1 = xd[1], y0 = yd[0], y1 = yd[1];
  const sx = xScale, sy = yScale;
  return { left, right, top, bottom, width, height, x0, x1, y0, y1,
    px:v => left + (sx(v) - sx(x0)) / (sx(x1) - sx(x0)) * (right - left),
    py:v => bottom - (sy(v) - sy(y0)) / (sy(y1) - sy(y0)) * (bottom - top) };
}
// Hit test, tooltip, pan, wheel zoom, box zoom and lasso over a set of drawn points.
function placeTip(canvas, tip, x, y, html) {
  const rect = canvas.getBoundingClientRect();
  tip.innerHTML = html; tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${x + 12 + tw > rect.width ? Math.max(4, x - tw - 12) : x + 12}px`;
  tip.style.top = `${Math.max(4, Math.min(rect.height - th - 4, y - th / 2))}px`;
}
function nearest(hit, mx, my, limit) {
  let best = -1, bestD = limit;
  for (let k = 0; k < hit.sx.length; k++) { const d = (hit.sx[k] - mx) ** 2 + (hit.sy[k] - my) ** 2; if (d < bestD) { bestD = d; best = k; } }
  return best;
}
function attachHover(canvas, getHit, tipHTML, onPick) {
  const wrap = canvas.parentElement, tip = wrap.querySelector('.chart-tooltip');
  let overlay = wrap.querySelector('.sh-overlay');
  if (!overlay) { overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); overlay.classList.add('sh-overlay'); wrap.append(overlay); }
  canvas._tip = (k, hit) => placeTip(canvas, tip, hit.sx[k], hit.sy[k], tipHTML(hit.idx[k]));
  const local = event => { const rect = canvas.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; };
  const toData = (plot, px, py) => [plot.x0 + (px - plot.left) / (plot.right - plot.left) * (plot.x1 - plot.x0), plot.y0 + (plot.bottom - py) / (plot.bottom - plot.top) * (plot.y1 - plot.y0)];
  const setZoom = (xd, yd) => { link.zoom = { key:zoomKey(), xd, yd }; redraw(); };
  let drag = null, frame = 0;
  canvas.onpointerdown = event => {
    const hit = getHit();
    if (!hit || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    const p = local(event);
    drag = { tool:link.tool, start:p, last:p, path:[p], moved:false, plot:hit.plot, add:event.shiftKey };
    tip.hidden = true;
  };
  canvas.onpointermove = event => {
    const hit = getHit(), [mx, my] = local(event);
    if (!hit) return;
    if (drag) {
      if (Math.hypot(mx - drag.start[0], my - drag.start[1]) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (drag.tool === 'lasso') { drag.path.push([mx, my]); overlay.innerHTML = `<polygon points="${drag.path.map(p => p.join(',')).join(' ')}"/>`; }
      else if (drag.tool === 'zoom') { const [a, b] = drag.start; overlay.innerHTML = `<rect x="${Math.min(a, mx)}" y="${Math.min(b, my)}" width="${Math.abs(mx - a)}" height="${Math.abs(my - b)}"/>`; }
      else {
        const plot = hit.plot, [ax, ay] = toData(plot, drag.last[0], drag.last[1]), [bx, by] = toData(plot, mx, my);
        drag.last = [mx, my];
        link.zoom = { key:zoomKey(), xd:[plot.x0 - (bx - ax), plot.x1 - (bx - ax)], yd:[plot.y0 - (by - ay), plot.y1 - (by - ay)] };
        cancelAnimationFrame(frame); frame = requestAnimationFrame(redraw);
      }
      return;
    }
    const best = nearest(hit, mx, my, 64);
    canvas.style.cursor = best >= 0 ? 'pointer' : link.tool === 'pick' ? 'grab' : 'crosshair';
    if (best < 0) { tip.hidden = true; return; }
    canvas._tip(best, hit);
  };
  canvas.onpointerup = event => {
    const hit = getHit(), d = drag;
    drag = null; overlay.innerHTML = '';
    if (!hit || !d) return;
    const [mx, my] = local(event);
    if (!d.moved) { const best = nearest(hit, mx, my, 100); if (best >= 0) onPick(hit.idx[best]); return; }
    if (d.tool === 'lasso' && d.path.length > 2) {
      const set = new Set(d.add && link.sel ? link.sel : []);
      for (let k = 0; k < hit.sx.length; k++) if (inside(hit.sx[k], hit.sy[k], d.path)) set.add(hit.idx[k]);
      setSelection(set);
    } else if (d.tool === 'zoom') {
      const [ax, ay] = toData(d.plot, d.start[0], d.start[1]), [bx, by] = toData(d.plot, mx, my);
      if (Math.abs(mx - d.start[0]) > 6 && Math.abs(my - d.start[1]) > 6) setZoom([Math.min(ax, bx), Math.max(ax, bx)], [Math.min(ay, by), Math.max(ay, by)]);
    }
  };
  canvas.onpointerleave = () => { if (!drag) tip.hidden = true; canvas.style.cursor = ''; };
  canvas.onwheel = event => {
    const hit = getHit();
    if (!hit) return;
    event.preventDefault();
    const plot = hit.plot, [mx, my] = local(event), [cx, cy] = toData(plot, mx, my), f = event.deltaY > 0 ? 1.2 : 1 / 1.2;
    link.zoom = { key:zoomKey(), xd:[cx - (cx - plot.x0) * f, cx + (plot.x1 - cx) * f], yd:[cy - (cy - plot.y0) * f, cy + (plot.y1 - cy) * f] };
    cancelAnimationFrame(frame); frame = requestAnimationFrame(redraw);
  };
  canvas.onclick = null;
}
export function openPlace(level, index) {
  const s = store && store.level === level ? store : null;
  if (!s) return;
  const props = { region_id:s.ids[index], region_label:s.labels[index], mean:s.mean[index], q05:s.q05[index], q95:s.q95[index], p_talarico:s.pTal[index] };
  selectPlace(level, props);
  window.dispatchEvent(new CustomEvent('zoom-place', { detail:{ level, id:s.ids[index] } }));
}
const placeName = i => shortLabel(store.level, store.labels[i], counties);
function pairTip(i, from, to, ev, heading) {
  const a = raceOf(from), b = raceOf(to), tpA = tpOf(store, from)[i], tpB = tpOf(store, to)[i];
  return `${heading ? `<strong>${escapeHTML(heading)}</strong>` : ''}${escapeHTML(a.label)}: ${pct(ev.shareA[i])} of ${count(tpA)} votes<br>${escapeHTML(b.label)}: ${pct(ev.shareB[i])} of ${count(tpB)} votes<br>Shift: ${points(ev.shift[i])}`;
}

// Unselected points first, then selected ones on top; within each, larger places first so small ones stay visible.
const byDrawOrder = (idx, w) => idx.slice().sort((a, b) => (link.sel ? (link.sel.has(a) - link.sel.has(b)) : 0) || w[b] - w[a]);
function selectionText(idx, xs, ys, weights) {
  if (!link.sel) return '';
  const chosen = idx.filter(i => link.sel.has(i));
  const fit = chosen.length >= 3 ? weightedFit(xs, ys, weights, chosen) : null;
  return ` · selection: ${chosen.length.toLocaleString('en-US')} shown${fit ? `, correlation ${fit.r.toFixed(2)}, slope ${fit.slope.toFixed(2)}` : ''}`;
}

// ---- View 1: shift vs shift ----
let xyHit = null;
function drawXY() {
  const canvas = $('#sh-xy-canvas'), c = ink();
  const evX = evaluate(store, state.from, state.to), evY = evaluate(store, state.y2from, state.y2to);
  const xs = metricArray(evX, state.xrel ? 'rshift' : 'shift'), ys = metricArray(evY, state.yrel ? 'rshift' : 'shift');
  const idx = [];
  for (let i = 0; i < store.n; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) idx.push(i);
  idx.splice(0, idx.length, ...restrict(idx));
  const { ctx, width, height } = setup(canvas);
  if (idx.length < 3) { ctx.fillStyle = c.muted; ctx.font = "12px 'DM Sans', system-ui, sans-serif"; ctx.textAlign = 'center'; ctx.fillText('Too few places have both shifts under the current filters.', width / 2, height / 2); xyHit = null; $('#sh-xy-stats').textContent = ''; return; }
  const [xd, yd] = domainFor(domainOf(idx.map(i => xs[i]), { zero:true }), domainOf(idx.map(i => ys[i]), { zero:true }));
  const plot = makePlot(width, height, xd, yd);
  const pts = v => Math.round(100 * v) === 0 ? '0' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(100 * v))}`;
  const ticks = (d, step = 0) => scaleLinear().domain(d).ticks(width < 360 ? 4 : 6);
  drawFrame(ctx, plot, { xTicks:ticks(xd), yTicks:ticks(yd), xFormat:pts, yFormat:pts, zeroX:0, zeroY:0,
    xLabel:`${state.xrel ? 'Relative shift' : 'Shift'}, ${raceOf(state.from).short} to ${raceOf(state.to).short} (points)`, yLabel:`${state.yrel ? 'Relative shift' : 'Shift'}, ${raceOf(state.y2from).short} to ${raceOf(state.y2to).short} (points)` });
  const wA = tpOf(store, state.from), weights = state.weighted ? wA : null;
  const sorted = idx.map(i => wA[i]).sort((a, b) => a - b), wmax = quantile(sorted, .98) || 1;
  let sets = null;
  ctx.save(); ctx.beginPath(); ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top); ctx.clip();
  // Optional highest-density regions from vote-weighted bins, smoothed once, drawn under the points.
  if (state.contours) {
    const bins = 48, grid = Array.from({ length:bins }, () => new Float64Array(bins));
    for (const i of idx) {
      const gx = Math.floor((xs[i] - xd[0]) / (xd[1] - xd[0]) * bins), gy = Math.floor((ys[i] - yd[0]) / (yd[1] - yd[0]) * bins);
      if (gx >= 0 && gx < bins && gy >= 0 && gy < bins) grid[gy][gx] += weights ? weights[i] : 1;
    }
    const smooth = Array.from({ length:bins }, () => new Float64Array(bins)), kernel = [1, 2, 1];
    let total = 0;
    for (let gy = 0; gy < bins; gy++) for (let gx = 0; gx < bins; gx++) {
      let sum = 0, norm = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = gy + dy, xx = gx + dx; if (yy < 0 || xx < 0 || yy >= bins || xx >= bins) continue; const k = kernel[dy + 1] * kernel[dx + 1]; sum += k * grid[yy][xx]; norm += k; }
      smooth[gy][gx] = sum / norm; total += smooth[gy][gx];
    }
    const cells = [];
    for (let gy = 0; gy < bins; gy++) for (let gx = 0; gx < bins; gx++) if (smooth[gy][gx] / total > 1e-6) cells.push({ x:xd[0] + (gx + .5) / bins * (xd[1] - xd[0]), y:yd[0] + (gy + .5) / bins * (yd[1] - yd[0]), m:smooth[gy][gx] / total });
    sets = contours(cells);
  }
  const sx = [], sy = [], order = byDrawOrder(idx, wA), shown = [];
  const colors = profileColors();
  for (const i of order) {
    const px = plot.px(xs[i]), py = plot.py(ys[i]);
    if (px < plot.left || px > plot.right || py < plot.top || py > plot.bottom) continue;
    sx.push(px); sy.push(py); shown.push(i);
    const on = pointStyle(i, ctx, .45);
    ctx.fillStyle = state.color === 'share' ? shareColor(evX.shareA[i], dark() ? 'dark' : 'light') : (store.profile[i] === 255 ? c.muted : colors[store.profile[i]]);
    ctx.beginPath(); ctx.arc(px, py, 1.3 + 4.2 * Math.sqrt(Math.min(1, wA[i] / wmax)), 0, 6.2832); ctx.fill();
    if (on) { ctx.strokeStyle = c.text; ctx.lineWidth = .8; ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  if (state.contours && sets) {
    const widths = [2.4, 1.7, 1.3], alphas = [1, .9, .75];
    // A soft halo in the panel color keeps the lines readable over the points.
    sets.forEach((segments, level) => { for (const [stroke, width, alpha] of [[c.panel, widths[level] + 2.6, .55], [c.text, widths[level], alphas[level]]]) { ctx.strokeStyle = stroke; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.beginPath(); for (const [a, b] of segments) { ctx.moveTo(plot.px(a[0]), plot.py(a[1])); ctx.lineTo(plot.px(b[0]), plot.py(b[1])); } ctx.stroke(); } });
    ctx.globalAlpha = 1;
  }
  const fit = weightedFit(xs, ys, weights, idx);
  if (fit) {
    const a = fit.intercept + fit.slope * xd[0], b = fit.intercept + fit.slope * xd[1];
    ctx.strokeStyle = c.fit; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(plot.px(xd[0]), plot.py(a)); ctx.lineTo(plot.px(xd[1]), plot.py(b)); ctx.stroke();
  }
  ctx.restore();
  const outside = idx.filter(i => xs[i] < xd[0] || xs[i] > xd[1] || ys[i] < yd[0] || ys[i] > yd[1]).length;
  xyHit = { sx, sy, idx:shown, plot };
  drawFocus(ctx, xyHit);
  $('#sh-xy-stats').innerHTML = fit ? `${state.weighted ? 'Vote-weighted' : 'Unweighted'} correlation <strong>${fit.r.toFixed(2)}</strong> · least-squares slope <strong>${fit.slope.toFixed(2)}</strong> (the line shown) · ${idx.length.toLocaleString('en-US')} ${levelInfo[store.level].noun}${state.contours ? ' · contours enclose 50%, 80% and 95% of the weight (smoothed bins)' : ''}${outside ? ` · ${outside.toLocaleString('en-US')} beyond the axis limits not drawn` : ''}${selectionText(idx, xs, ys, weights)}.${restrictText()}` : '';
  attachHover(canvas, () => xyHit, i => `<strong>${escapeHTML(placeName(i))}</strong>${pairTip(i, state.from, state.to, evX)}<br>${escapeHTML(raceOf(state.y2from).label)} to ${escapeHTML(raceOf(state.y2to).label)}: ${points(evY.shift[i])}`, i => openPlace(store.level, i));
  const legend = $('#sh-xy-legend');
  legend.innerHTML = state.color === 'share' ? `<span>Color: Democratic share in ${escapeHTML(raceOf(state.from).label)}</span><span class="sh-ramp"></span><span>Point area: two-party votes in ${escapeHTML(raceOf(state.from).label)}</span>` : `${profileNames.map((key, k) => `<span><i style="background:${colors[k]}"></i>${profileLabels[key]}</span>`).join('')}<span>Point area: two-party votes in ${escapeHTML(raceOf(state.from).label)}</span>`;
}

// ---- View 2: shift vs demographics ----
// Measures come from the shared catalog; two entries belong to this panel and follow its From and To races.
const pairEntries = () => [
  { key:'pair_shift', label:`${state.xrel ? 'Relative shift' : 'Shift'}, ${raceOf(state.from).short} to ${raceOf(state.to).short}`, group:'Politics', type:'shift', unit:'points', source:'pair' },
  { key:'share_from', label:`Democratic share, ${raceOf(state.from).short}`, group:'Politics', type:'share', unit:'share', source:'pair' },
];
const presets = { age:['pct_65plus', 'pair_shift'], rent:['median_gross_rent', 'pair_shift'], moved:['pct_moved_since_2010', 'pair_shift'], value:['median_home_value', 'mean'], educ:['pct_ba_plus', 'pair_shift'] };
// Eleven group colours: the eight validated categorical slots, then three more. Each bar also names its group in text.
const groupColors = () => dark()
  ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#3fa63f', '#9085e9', '#e66767', '#b08d62', '#8fa9b8', '#3fb0c0']
  : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#8c6d46', '#5f7a8a', '#0f7c8c'];
const rankGroups = [...acsGroups, 'Race and ethnicity', 'Model inputs'];
const sx = { catalog:null, acs:null, table:null, perm:null, pickers:null, plot:null, mode:'binned', y:'pair_shift', c:'p_talarico', target:'pres24', rankAll:false, rankCache:new Map(), usableKey:'' };
// Row k of the level table for row i of the store; both come from the same details file but are matched by id to be safe.
async function demogTable() {
  const t = await levelTable(store.level).catch(() => null);
  if (t && t !== sx.table) { sx.table = t; sx.perm = Int32Array.from(store.ids, id => t.index.get(String(id)) ?? -1); sx.usableKey = ''; }
  return t;
}
function valuesOf(entry, s = store, ev = null, table = sx.table, perm = sx.perm) {
  if (!entry) return null;
  if (entry.source === 'pair') return entry.key === 'share_from' ? shareOf(s, state.from) : metricArray(ev || evaluate(s, state.from, state.to), state.xrel ? 'rshift' : 'shift');
  if (!table) return null;
  const col = table.column(entry.key, entry.source);
  return Float64Array.from(perm, k => k < 0 ? NaN : col[k]);
}
const moeOf = entry => entry?.hasMoe && sx.table ? valuesOf({ key:`${entry.key}_moe`, source:'details' }) : null;
function drawDemog() {
  const t = sx.table, c = ink();
  if (!sx.catalog || !t || t.level !== store.level) { $('#sh-demog-stats').textContent = 'Loading measures…'; return; }
  const ev = evaluate(store, state.from, state.to);
  const key = `${store.level}|${state.from}|${state.to}|${state.xrel}`;
  if (sx.usableKey !== key) { sx.usable = [...sx.catalog, ...pairEntries()].filter(e => { const v = valuesOf(e, store, ev); return v && finiteCount(v) >= MIN_UNITS; }); sx.usableKey = key; }
  const usable = sx.usable;
  state.demog = sx.pickers.x.set(usable, usable.some(e => e.key === state.demog) ? state.demog : 'hisp_cvap_share');
  sx.y = sx.pickers.y.set(usable, sx.y); sx.c = sx.pickers.c.set(usable, sx.c);
  const xm = sx.pickers.x.entry(), ym = sx.pickers.y.entry(), cm = sx.pickers.c.entry();
  // The panel's filters (minimum votes, county, profile) and spatial restrictions apply to every measure.
  const keep = new Uint8Array(store.n);
  const all = []; for (let i = 0; i < store.n; i++) if (ev.status[i] === STATUS.ok) all.push(i);
  for (const i of restrict(all)) keep[i] = 1;
  const xs = valuesOf(xm, store, ev).map((v, i) => keep[i] ? v : NaN), ys = valuesOf(ym, store, ev);
  const w = state.weighted ? tpOf(store, state.from) : null, noun = levelInfo[store.level].noun;
  const marked = link.focus >= 0 ? [link.focus] : [];
  sx.plot.draw({ n:store.n, labels:Array.from({ length:store.n }, (_, i) => placeName(i)), x:xs, y:ys, c:valuesOf(cm, store, ev), w, xm, ym, cm, xMoe:moeOf(xm), yMoe:moeOf(ym), cMoe:moeOf(cm),
    mode:sx.mode, sizeByWeight:true, noun, yRef:ym?.unit === 'points' ? 0 : null, height:Math.round(Math.min(Math.max(($('#sh-plot').clientWidth || 320) * .7, 260), 420)), marked, brushed:link.sel ? [...link.sel] : [],
    onStats:st => {
      const weight = state.weighted ? `weighted by two-party votes in ${raceOf(state.from).label}` : 'unweighted';
      $('#sh-demog-stats').textContent = `${st.n.toLocaleString('en-US')} ${noun} with both values${st.slopeText ? ` · ${st.slopeText}, ${weight}` : st.n < 30 ? ' · too few for a fit' : ''}${sx.mode === 'points' && sx.plot.state?.shown < st.n ? ` · ${sx.plot.state.shown.toLocaleString('en-US')} drawn` : ''}.${restrictText()}`;
      $('#sh-demog-legend').innerHTML = colorLegend(cm, st.colorRange);
    } });
  for (const b of panel.querySelectorAll('[data-sh-mode]')) b.setAttribute('aria-pressed', String(b.dataset.shMode === sx.mode));
  for (const b of panel.querySelectorAll('[data-sh-preset]')) { const [px, py] = presets[b.dataset.shPreset]; b.disabled = !usable.some(e => e.key === px) || !usable.some(e => e.key === py); b.setAttribute('aria-pressed', String(state.demog === px && sx.y === py)); }
  $('#sh-demog-clear').hidden = !link.sel;
  drawRank();
}
// Weighted correlation of each non-count demographic measure with a target, across precincts, weighted by the expected 2026 electorate.
let ranking = 0;
async function drawRank() {
  const box = $('#sh-rank');
  if (!sx.acs) { box.hidden = true; return; }
  box.hidden = false;
  const ym = sx.pickers.y.entry(), byY = sx.target === 'y' && ym;
  const target = byY ? ym : sx.catalog.find(e => e.key === 'base_pres24');
  for (const b of panel.querySelectorAll('[data-sh-target]')) b.setAttribute('aria-pressed', String(b.dataset.shTarget === (byY ? 'y' : 'pres24')));
  $('#sh-rank-title').textContent = byY ? `Which demographics track ${target.label.charAt(0).toLowerCase()}${target.label.slice(1)}` : 'Which demographics track the 2024 vote';
  const key = `${target.key}|${target.source === 'pair' ? `${state.from}|${state.to}|${state.xrel}|${state.min}|${state.county}|${state.profile}` : ''}`;
  const request = ++ranking;
  if (!sx.rankCache.has(key)) {
    const [ps, pt] = await Promise.all([ensureStore('precinct'), levelTable('precinct')]);
    if (request !== ranking) return;
    const perm = Int32Array.from(ps.ids, id => pt.index.get(String(id)) ?? -1);
    const y = valuesOf(target, ps, target.source === 'pair' ? evaluate(ps, state.from, state.to) : null, pt, perm);
    const ballots = valuesOf({ key:'ballots_mean', source:'details' }, ps, null, pt, perm);
    const rows = [];
    for (const e of sx.catalog) {
      if (e.type === 'count' || e.key === target.key || !rankGroups.includes(e.group)) continue;
      const x = valuesOf(e, ps, null, pt, perm), idx = [];
      for (let i = 0; i < ps.n; i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i]) && ballots[i] > 0) idx.push(i);
      if (idx.length < MIN_UNITS) continue;
      const fit = xyFit(x, y, ballots, idx);
      if (fit) rows.push({ e, r:fit.r, n:idx.length });
    }
    rows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    sx.rankCache.set(key, rows);
  }
  const rows = sx.rankCache.get(key), colors = groupColors(), shown = sx.rankAll ? rows : rows.slice(0, 15);
  const usable = new Set(sx.usable.map(e => e.key));
  $('#sh-rank-note').textContent = `Weighted correlation across precincts between each measure and ${target.label.charAt(0).toLowerCase()}${target.label.slice(1)}, weighted by the expected 2026 electorate. These are associations across precincts. Measures with fewer than ${MIN_UNITS} precincts holding both values are left out. Click a bar to put that measure on the X axis.`;
  $('#sh-rank-list').innerHTML = shown.map(({ e, r, n }) => {
    const color = colors[rankGroups.indexOf(e.group)], wpct = Math.abs(r) * 50;
    return `<li><button type="button" class="sh-rank-row${e.key === state.demog ? ' current' : ''}" data-key="${escapeHTML(e.key)}" ${usable.has(e.key) ? '' : 'disabled title="Not available at this level"'} aria-label="${escapeHTML(`${e.label} (${e.group}): r = ${r.toFixed(2)}, ${n.toLocaleString('en-US')} precincts`)}">
      <span class="sh-rank-label">${escapeHTML(e.label)}<em>${escapeHTML(e.group)}</em></span>
      <span class="sh-rank-bar"><i style="background:${color};${r >= 0 ? `left:50%` : `right:50%`};width:${wpct}%"></i></span>
      <span class="sh-rank-r">${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}</span></button></li>`;
  }).join('') || '<li class="note">No measure has enough precincts with values.</li>';
  $('#sh-rank-more').hidden = rows.length <= 15;
  $('#sh-rank-more').textContent = sx.rankAll ? 'Show top 15' : `Show all ${rows.length}`;
  const groups = rankGroups.filter(g => rows.some(x => x.e.group === g));
  $('#sh-rank-legend').innerHTML = groups.map(g => `<span><i style="background:${colors[rankGroups.indexOf(g)]}"></i>${escapeHTML(g)}</span>`).join('');
}
async function initDemog() {
  sx.acs = await loadDemographics();
  sx.catalog = [...(sx.acs?.entries || []), ...(await modelEntries())];
  $('#sh-presets').hidden = !sx.acs;
  $('#sh-method').hidden = !sx.acs;
  if (sx.acs) $('#sh-method').textContent = methodNote(sx.acs);
  sx.pickers = {
    x:createPicker($('#sh-px'), { label:'X', onChange:v => set({ demog:v }) }),
    y:createPicker($('#sh-py'), { label:'Y', onChange:v => { sx.y = v; redraw(); } }),
    c:createPicker($('#sh-pc'), { label:'Colour', onChange:v => { sx.c = v; redraw(); } }),
  };
  sx.plot = createXYPlot($('#sh-plot'), {
    onPick:i => openPlace(store.level, i),
    onBrush:idx => setSelection(new Set(idx)),
  });
  for (const b of panel.querySelectorAll('[data-sh-mode]')) b.addEventListener('click', () => { sx.mode = b.dataset.shMode; redraw(); });
  for (const b of panel.querySelectorAll('[data-sh-preset]')) b.addEventListener('click', () => { const [px, py] = presets[b.dataset.shPreset]; sx.y = py; set({ demog:px }); });
  for (const b of panel.querySelectorAll('[data-sh-target]')) b.addEventListener('click', () => { sx.target = b.dataset.shTarget; drawRank(); });
  $('#sh-demog-clear').addEventListener('click', () => setSelection(null));
  $('#sh-rank-more').addEventListener('click', () => { sx.rankAll = !sx.rankAll; drawRank(); });
  $('#sh-rank-list').addEventListener('click', e => { const b = e.target.closest('[data-key]'); if (b && !b.disabled) set({ demog:b.dataset.key }); });
}
const set = (patch, what = 'view') => setState(patch, what);

// ---- View 3: movers table ----
const tableState = { sort:'shift', dir:-1, page:0, view:false };
const columns = [
  { key:'place', label:'Place', text:true }, { key:'county', label:'County', text:true }, { key:'profile', label:'Profile', text:true },
  { key:'shareA', label:'Share A', show:v => pct(v) }, { key:'shareB', label:'Share B', show:v => pct(v) },
  { key:'shift', label:'Shift', show:points }, { key:'rshift', label:'Relative shift', show:points },
  { key:'tpA', label:'Votes A', show:count }, { key:'tpB', label:'Votes B', show:count },
  { key:'ratio', label:'Turnout ratio', show:v => `×${v.toFixed(2)}` }, { key:'net', label:'Net D vote change', show:v => `${v >= 0 ? '+' : '−'}${count(Math.abs(v))}` },
];
async function tableRows() {
  const ev = evaluate(store, state.from, state.to);
  let idx = [];
  for (let i = 0; i < store.n; i++) if (ev.status[i] === STATUS.ok) idx.push(i);
  let view = null;
  if (link.area) idx = restrict(idx);
  if (tableState.view) view = viewBounds();
  if (boxes && view) idx = idx.filter(i => { const b = boxes[store.ids[i]]; return !b || (b[0] <= view[2] && b[2] >= view[0] && b[1] <= view[3] && b[3] >= view[1]); });
  const cell = (i, key) => key === 'place' ? placeName(i) : key === 'county' ? counties.get(store.county[i]) || '' : key === 'profile' ? (store.profile[i] === 255 ? '' : profileLabels[profileNames[store.profile[i]]])
    : key === 'shareA' ? ev.shareA[i] : key === 'shareB' ? ev.shareB[i] : key === 'shift' ? ev.shift[i] : key === 'rshift' ? ev.shift[i] - ev.stateShift : key === 'tpA' ? ev.tpA[i] : key === 'tpB' ? ev.tpB[i] : key === 'ratio' ? ev.ratio[i] : ev.net[i];
  return { ev, idx, cell };
}
async function drawTable() {
  const host = $('#sh-table-body'), { ev, idx, cell } = await tableRows();
  const col = columns.find(c => c.key === tableState.sort) || columns[5];
  const key = col.key;
  const sorted = idx.slice().sort((a, b) => {
    const x = cell(a, key), y = cell(b, key);
    return (col.text ? String(x).localeCompare(String(y)) : x - y) * tableState.dir;
  });
  const pages = Math.max(1, Math.ceil(sorted.length / 50));
  tableState.page = Math.min(tableState.page, pages - 1);
  const show = sorted.slice(tableState.page * 50, tableState.page * 50 + 50);
  const labelA = raceOf(state.from).short, labelB = raceOf(state.to).short;
  const heading = c => c.key === 'shareA' ? `Share, ${labelA}` : c.key === 'shareB' ? `Share, ${labelB}` : c.key === 'tpA' ? `Votes, ${labelA}` : c.key === 'tpB' ? `Votes, ${labelB}` : c.label;
  const head = columns.map(c => `<th class="${c.text ? 'name' : ''}" aria-sort="${c.key === key ? (tableState.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sh-sort="${c.key}">${escapeHTML(heading(c))}</button></th>`).join('');
  const body = show.map(i => `<tr data-i="${i}" tabindex="0">${columns.map(c => `<td class="${c.text ? 'name' : ''}">${escapeHTML(c.text ? cell(i, c.key) : c.show(cell(i, c.key)))}</td>`).join('')}</tr>`).join('');
  host.innerHTML = `<div class="sh-table-scroll"><table class="sh-table"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${columns.length}">No places match these filters.</td></tr>`}</tbody></table></div>
    <div class="sh-pager"><span>${sorted.length.toLocaleString('en-US')} ${levelInfo[store.level].noun}</span><button type="button" data-sh-page="-1" ${tableState.page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${tableState.page + 1} of ${pages}</span><button type="button" data-sh-page="1" ${tableState.page >= pages - 1 ? 'disabled' : ''}>Next</button></div>`;
  host._rows = { sorted, cell, ev };
}
function downloadCSV() {
  const host = $('#sh-table-body');
  if (!host._rows) return;
  const { sorted, cell } = host._rows;
  const quote = v => `"${String(v).replaceAll('"', '""')}"`;
  const header = ['region_id', 'place', 'county', 'profile', `share_${state.from}`, `share_${state.to}`, 'shift', 'relative_shift', `two_party_votes_${state.from}`, `two_party_votes_${state.to}`, 'turnout_ratio', 'net_democratic_vote_change'];
  const lines = [header.join(',')];
  for (const i of sorted) lines.push([quote(store.ids[i]), quote(cell(i, 'place')), quote(cell(i, 'county')), quote(cell(i, 'profile')), ...['shareA', 'shareB', 'shift', 'rshift', 'tpA', 'tpB', 'ratio', 'net'].map(k => cell(i, k))].join(','));
  const url = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type:'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${store.level}_shifts_${state.from}_${state.to}.csv`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Orchestration ----
let drawing = 0;
async function redraw() {
  if (panel.hidden || !store || store.level !== state.level) return;
  const request = ++drawing;
  syncControls(); syncTools();
  for (const tip of panel.querySelectorAll('.sh-canvas .chart-tooltip')) tip.hidden = true;
  const ev = evaluate(store, state.from, state.to);
  renderHeader(ev, levelInfo[store.level].noun);
  renderSummary(ev);
  if (state.view === 'xy') drawXY(); else if (state.view === 'demog') { await demogTable(); if (request !== drawing) return; drawDemog(); } else { await drawTable(); if (request !== drawing) return; }
}
async function load() {
  if (loading) return loading;
  const status = $('#sh-status');
  loading = (async () => {
    status.hidden = false; status.textContent = 'Loading precinct data…';
    try {
      [store, counties, boxes] = await Promise.all([ensureStore(state.level), countyNames(), boxesFor(state.level).catch(() => null)]);
      indexOf = new Map(Array.from(store.ids, (id, i) => [String(id), i]));
      const names = [...counties.entries()].sort((a, b) => a[1].localeCompare(b[1]));
      $('#sh-county-list').replaceChildren(...names.map(([, name]) => new Option(name)));
      status.hidden = true;
      renderCheck();
      redraw();
    } catch (error) { status.textContent = `The data could not be loaded: ${error.message}`; loading = null; }
  })();
  return loading;
}
async function changeLevel() {
  loading = null; store = null; boxes = null; indexOf = null;
  link.sel = null; link.focus = -1; link.zoom = null; setBrush(null, null);
  await load();
}
function init() {
  build(); syncControls();
  initDemog().then(() => redraw()).catch(error => console.error('Demographic measures could not be loaded', error));
  const set = (patch, what = 'pair') => setState(patch, what);
  $('#sh-from').addEventListener('change', e => set({ from:e.target.value }));
  $('#sh-to').addEventListener('change', e => set({ to:e.target.value }));
  $('#sh-y2from').addEventListener('change', e => set({ y2from:e.target.value }, 'view'));
  $('#sh-y2to').addEventListener('change', e => set({ y2to:e.target.value }, 'view'));
  $('#sh-min').addEventListener('change', e => set({ min:+e.target.value }, 'filters'));
  $('#sh-weight').addEventListener('change', e => set({ weighted:e.target.value === '1' }, 'view'));
  $('#sh-profile').addEventListener('change', e => set({ profile:e.target.value }, 'filters'));
  $('#sh-level').addEventListener('change', e => { set({ level:e.target.value }, 'view'); changeLevel(); });
  $('#sh-county').addEventListener('change', e => {
    const text = e.target.value.trim().toLowerCase();
    if (!text) return set({ county:'' }, 'filters');
    const hit = [...counties.entries()].find(([, name]) => name.toLowerCase() === text);
    if (hit) set({ county:hit[0] }, 'filters'); else e.target.value = state.county ? counties.get(state.county) || '' : '';
  });
  $('#sh-xrel').addEventListener('change', e => set({ xrel:e.target.checked }, 'view'));
  $('#sh-demog-rel').addEventListener('change', e => set({ xrel:e.target.checked }, 'view'));
  $('#sh-yrel').addEventListener('change', e => set({ yrel:e.target.checked }, 'view'));
  $('#sh-color').addEventListener('change', e => set({ color:e.target.value }, 'view'));
  $('#sh-contours').addEventListener('change', e => set({ contours:e.target.checked }, 'view'));
  for (const button of panel.querySelectorAll('[data-sh-view]')) button.addEventListener('click', () => set({ view:button.dataset.shView }, 'view'));
  $('#sh-view-table').addEventListener('click', event => {
    const sort = event.target.closest('[data-sh-sort]'), page = event.target.closest('[data-sh-page]'), row = event.target.closest('tr[data-i]');
    if (sort) { const key = sort.dataset.shSort; if (tableState.sort === key) tableState.dir = -tableState.dir; else { tableState.sort = key; tableState.dir = columns.find(c => c.key === key).text ? 1 : -1; } tableState.page = 0; drawTable(); }
    else if (page) { tableState.page += +page.dataset.shPage; drawTable(); }
    else if (row) openPlace(store.level, +row.dataset.i);
  });
  $('#sh-view-table').addEventListener('keydown', event => { const row = event.target.closest('tr[data-i]'); if (row && event.key === 'Enter') openPlace(store.level, +row.dataset.i); });
  $('#sh-inview').addEventListener('change', e => { tableState.view = e.target.checked; tableState.page = 0; drawTable(); });
  $('#sh-csv').addEventListener('click', downloadCSV);
  for (const button of panel.querySelectorAll('[data-sh-tool]')) button.addEventListener('click', () => { link.tool = button.dataset.shTool; syncTools(); });
  $('#sh-zoom-reset').addEventListener('click', () => { link.zoom = null; redraw(); });
  $('#sh-sel-clear').addEventListener('click', () => setSelection(null));
  $('#sh-restrict').addEventListener('change', e => { link.inView = e.target.checked; redraw(); });
  $('#sh-draw').addEventListener('click', () => {
    $('#sh-draw').textContent = 'Drawing: click corners, double-click to finish';
    startDraw(ring => { $('#sh-draw').textContent = 'Draw area on map'; link.area = ring; redraw(); });
  });
  $('#sh-area-clear').addEventListener('click', () => { cancelDraw(); link.area = null; setArea(null); redraw(); });
  // A place clicked on the map is ringed on the chart and its tooltip opened, when the chart shows that level.
  window.addEventListener('map-place-click', ({ detail }) => {
    if (panel.hidden || !store || !indexOf || detail.level !== store.level || state.view === 'table') return;
    const i = indexOf.get(detail.id);
    if (i === undefined) return;
    link.focus = i;
    if (state.view === 'demog') { redraw(); return; }
    if (link.zoom && xyHit && !xyHit.idx.includes(i)) link.zoom = null;
    redraw();
    const canvas = $('#sh-xy-canvas'), k = xyHit ? xyHit.idx.indexOf(i) : -1;
    if (k >= 0) canvas._tip(k, xyHit);
    else { const tip = canvas.parentElement.querySelector('.chart-tooltip'); placeTip(canvas, tip, 60, 30, `<strong>${escapeHTML(placeName(i))}</strong>Not on this chart: it is missing a race or excluded by the filters.`); }
  });
  window.addEventListener('compare-change', () => { tableState.page = 0; if (!panel.hidden) { load(); redraw(); } });
  window.addEventListener('view-change', () => { if (panel.hidden) return; if (state.view === 'table' && tableState.view) drawTable(); else if (state.view !== 'table' && link.inView) redraw(); });
  window.addEventListener('display-change', () => redraw());
  window.addEventListener('panel-layout', () => { if (!panel.hidden) { load(); redraw(); } });
  new ResizeObserver(() => { if (!panel.hidden) redraw(); }).observe($('#sh-views'));
  if (!panel.hidden) load();
}
init();
