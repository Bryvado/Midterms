import { scaleLinear } from 'd3-scale';
import { csv, pct, count, signed, escapeHTML } from './data.js';
import { state, setState, races, raceOf, metrics, profileNames, profileLabels, minOptions, levelInfo, ensureStore, evaluate, metricArray, STATUS, weightedMean, weightedFit, weightedDeciles, pairLabel, crossOffice, crossesSources, sourceCaveat, pastKeys, statewide, tpOf, shareOf } from './compare.js';
import { contours } from './contours.js';
import { selectPlace } from './details.js';
import { countyNames, shortLabel } from './labels.js';
import { viewBounds, shareColor } from './map.js';
import { boxesFor } from './list.js';

const panel = document.querySelector('#fp-shifts');
const $ = selector => panel.querySelector(selector);
const dark = () => document.documentElement.dataset.layout === 'dark';
const ink = () => dark() ? { text:'#e5edf2', muted:'#acbfcb', grid:'#364a5b', zero:'#8aa1b2', panel:'#1b2937', fit:'#f4d27a' } : { text:'#1b282d', muted:'#64767b', grid:'#e3e9e8', zero:'#8e9ea3', panel:'#ffffff', fit:'#8a5a00' };
const profileColors = () => dark() ? ['#e0b155', '#5fcbb0', '#b998dc', '#ff9a63'] : ['#b8892f', '#2f9a80', '#7b55a6', '#d9662a'];
const demogOptions = [
  ['hisp_cvap_share', 'Hispanic share of citizen adults', 'share'], ['white_cvap_share', 'White share of citizen adults', 'share'], ['black_cvap_share', 'Black share of citizen adults', 'share'],
  ['ba_plus_share', "Bachelor's degree or higher", 'share'], ['med_income', 'Median income (log scale)', 'log'], ['density', 'Population density (log scale)', 'log'], ['share_from', 'Democratic share in the From race', 'share'],
];
const points = v => `${v >= 0 ? '+' : '−'}${Math.abs(100 * v).toFixed(1)} pts`;
let store = null, counties = new Map(), loading = null, checked = null;

function raceOptions(select, value) { select.replaceChildren(...races.map(race => new Option(race.label, race.key, false, race.key === value))); }
function build() {
  for (const [id, key] of [['#sh-from', 'from'], ['#sh-to', 'to'], ['#sh-y2from', 'y2from'], ['#sh-y2to', 'y2to']]) raceOptions($(id), state[key]);
  $('#sh-level').replaceChildren(...Object.entries(levelInfo).map(([key, info]) => new Option(info.label, key, false, key === state.level)));
  $('#sh-min').replaceChildren(...minOptions.map(v => new Option(v.toLocaleString('en-US'), String(v), false, v === state.min)));
  $('#sh-profile').replaceChildren(new Option('All profiles', ''), ...profileNames.map(key => new Option(profileLabels[key], key, false, key === state.profile)));
  $('#sh-demog').replaceChildren(...demogOptions.map(([key, label]) => new Option(label, key, false, key === state.demog)));
}
function syncControls() {
  for (const [id, key] of [['#sh-from', 'from'], ['#sh-to', 'to'], ['#sh-y2from', 'y2from'], ['#sh-y2to', 'y2to'], ['#sh-level', 'level'], ['#sh-profile', 'profile'], ['#sh-demog', 'demog'], ['#sh-color', 'color']]) $(id).value = state[key];
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
// Hit test and tooltip over a set of drawn points.
function attachHover(canvas, getHit, tipHTML, onPick) {
  const wrap = canvas.parentElement, tip = wrap.querySelector('.chart-tooltip');
  canvas.onpointermove = event => {
    const hit = getHit(), rect = canvas.getBoundingClientRect();
    if (!hit) return;
    const mx = event.clientX - rect.left, my = event.clientY - rect.top;
    let best = -1, bestD = 64;
    for (let k = 0; k < hit.sx.length; k++) { const d = (hit.sx[k] - mx) ** 2 + (hit.sy[k] - my) ** 2; if (d < bestD) { bestD = d; best = k; } }
    if (best < 0) { tip.hidden = true; canvas.style.cursor = ''; return; }
    canvas.style.cursor = 'pointer';
    tip.innerHTML = tipHTML(hit.idx[best]); tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${hit.sx[best] + 12 + tw > rect.width ? Math.max(4, hit.sx[best] - tw - 12) : hit.sx[best] + 12}px`;
    tip.style.top = `${Math.max(4, Math.min(rect.height - th - 4, hit.sy[best] - th / 2))}px`;
  };
  canvas.onpointerleave = () => { tip.hidden = true; canvas.style.cursor = ''; };
  canvas.onclick = event => {
    const hit = getHit(), rect = canvas.getBoundingClientRect();
    if (!hit) return;
    const mx = event.clientX - rect.left, my = event.clientY - rect.top;
    let best = -1, bestD = 100;
    for (let k = 0; k < hit.sx.length; k++) { const d = (hit.sx[k] - mx) ** 2 + (hit.sy[k] - my) ** 2; if (d < bestD) { bestD = d; best = k; } }
    if (best >= 0) onPick(hit.idx[best]);
  };
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

// ---- View 1: shift vs shift ----
let xyHit = null;
function drawXY() {
  const canvas = $('#sh-xy-canvas'), c = ink();
  const evX = evaluate(store, state.from, state.to), evY = evaluate(store, state.y2from, state.y2to);
  const xs = metricArray(evX, state.xrel ? 'rshift' : 'shift'), ys = metricArray(evY, state.yrel ? 'rshift' : 'shift');
  const idx = [];
  for (let i = 0; i < store.n; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) idx.push(i);
  const { ctx, width, height } = setup(canvas);
  if (idx.length < 3) { ctx.fillStyle = c.muted; ctx.font = "12px 'DM Sans', system-ui, sans-serif"; ctx.textAlign = 'center'; ctx.fillText('Too few places have both shifts under the current filters.', width / 2, height / 2); xyHit = null; $('#sh-xy-stats').textContent = ''; return; }
  const xd = domainOf(idx.map(i => xs[i]), { zero:true }), yd = domainOf(idx.map(i => ys[i]), { zero:true });
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
  const sx = [], sy = [], order = idx.slice().sort((a, b) => wA[b] - wA[a]);
  const colors = profileColors();
  for (const i of order) {
    const px = plot.px(xs[i]), py = plot.py(ys[i]);
    sx.push(px); sy.push(py);
    ctx.globalAlpha = .45;
    ctx.fillStyle = state.color === 'share' ? shareColor(evX.shareA[i], dark() ? 'dark' : 'light') : (store.profile[i] === 255 ? c.muted : colors[store.profile[i]]);
    ctx.beginPath(); ctx.arc(px, py, 1.3 + 4.2 * Math.sqrt(Math.min(1, wA[i] / wmax)), 0, 6.2832); ctx.fill();
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
  xyHit = { sx, sy, idx:order };
  $('#sh-xy-stats').innerHTML = fit ? `${state.weighted ? 'Vote-weighted' : 'Unweighted'} correlation <strong>${fit.r.toFixed(2)}</strong> · least-squares slope <strong>${fit.slope.toFixed(2)}</strong> (the line shown) · ${idx.length.toLocaleString('en-US')} ${levelInfo[store.level].noun}${state.contours ? ' · contours enclose 50%, 80% and 95% of the weight (smoothed bins)' : ''}${outside ? ` · ${outside.toLocaleString('en-US')} beyond the axis limits not drawn` : ''}` : '';
  attachHover(canvas, () => xyHit, i => `<strong>${escapeHTML(placeName(i))}</strong>${pairTip(i, state.from, state.to, evX)}<br>${escapeHTML(raceOf(state.y2from).label)} to ${escapeHTML(raceOf(state.y2to).label)}: ${points(evY.shift[i])}`, i => openPlace(store.level, i));
  const legend = $('#sh-xy-legend');
  legend.innerHTML = state.color === 'share' ? `<span>Color: Democratic share in ${escapeHTML(raceOf(state.from).label)}</span><span class="sh-ramp"></span><span>Point area: two-party votes in ${escapeHTML(raceOf(state.from).label)}</span>` : `${profileNames.map((key, k) => `<span><i style="background:${colors[k]}"></i>${profileLabels[key]}</span>`).join('')}<span>Point area: two-party votes in ${escapeHTML(raceOf(state.from).label)}</span>`;
}

// ---- View 2: shift vs demographics ----
let demogHit = null;
function drawDemog() {
  const canvas = $('#sh-demog-canvas'), c = ink(), [key, label, kind] = demogOptions.find(option => option[0] === state.demog) || demogOptions[0];
  const ev = evaluate(store, state.from, state.to), ys = metricArray(ev, state.xrel ? 'rshift' : 'shift');
  const shareFrom = shareOf(store, state.from);
  const raw = key === 'density' ? Float64Array.from({ length:store.n }, (_, i) => store.demog.area_sqmi[i] > 0 ? store.demog.population[i] / store.demog.area_sqmi[i] : NaN) : key === 'share_from' ? shareFrom : store.demog[key];
  const log = kind === 'log';
  const idx = [];
  for (let i = 0; i < store.n; i++) if (Number.isFinite(ys[i]) && Number.isFinite(raw[i]) && (!log || raw[i] > 0)) idx.push(i);
  const { ctx, width, height } = setup(canvas);
  if (idx.length < 3) { ctx.fillStyle = c.muted; ctx.font = "12px 'DM Sans', system-ui, sans-serif"; ctx.textAlign = 'center'; ctx.fillText('Too few places have this measure and a shift under the current filters.', width / 2, height / 2); demogHit = null; $('#sh-demog-stats').textContent = ''; return; }
  const xs = log ? Float64Array.from(raw, v => v > 0 ? Math.log(v) : NaN) : raw;
  const bounded = kind === 'share';
  const xv = idx.map(i => bounded ? Math.min(1, Math.max(0, raw[i])) : xs[i]);
  const xd = bounded ? domainOf(xv, { lowQ:0, highQ:1 }) : domainOf(xv.slice(), { lowQ:.003, highQ:.997 });
  if (bounded) { xd[0] = Math.max(0, xd[0]); xd[1] = Math.min(1, xd[1]); }
  const yd = domainOf(idx.map(i => ys[i]), { zero:true });
  const plot = makePlot(width, height, xd, yd);
  const xTicks = log ? logTicks(Math.exp(xd[0]), Math.exp(xd[1])).map(Math.log) : scaleLinear().domain(xd).ticks(width < 360 ? 4 : 6);
  const fmtX = key === 'med_income' ? v => `$${Math.round(Math.exp(v) / 1000)}k` : key === 'density' ? v => { const d = Math.exp(v); return d >= 1000 ? `${Math.round(d / 1000)}k` : String(Math.round(d)); } : v => `${Math.round(100 * v)}%`;
  drawFrame(ctx, plot, { xTicks, yTicks:scaleLinear().domain(yd).ticks(6), xFormat:fmtX, yFormat:v => Math.round(100 * v) === 0 ? '0' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(100 * v))}`, zeroY:0, xLabel:label, yLabel:`${state.xrel ? 'Relative shift' : 'Shift'}, ${raceOf(state.from).short} to ${raceOf(state.to).short} (points)` });
  const wA = tpOf(store, state.from), weights = state.weighted ? wA : null, colors = profileColors();
  const sorted = idx.map(i => wA[i]).sort((a, b) => a - b), wmax = quantile(sorted, .98) || 1;
  ctx.save(); ctx.beginPath(); ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top); ctx.clip();
  const sx = [], sy = [], order = idx.slice().sort((a, b) => wA[b] - wA[a]);
  for (const i of order) {
    const xv2 = bounded ? Math.min(1, Math.max(0, raw[i])) : xs[i];
    const px = plot.px(xv2), py = plot.py(ys[i]), r = 1.3 + 3.6 * Math.sqrt(Math.min(1, wA[i] / wmax));
    sx.push(px); sy.push(py);
    const color = store.profile[i] === 255 ? c.muted : colors[store.profile[i]];
    if (store.imputed[i]) { ctx.globalAlpha = .8; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px, py, r + .5, 0, 6.2832); ctx.stroke(); }
    else { ctx.globalAlpha = .42; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  const xt = new Float64Array(store.n); for (const i of idx) xt[i] = bounded ? Math.min(1, Math.max(0, raw[i])) : xs[i];
  const deciles = weightedDeciles(xt, ys, weights, idx);
  ctx.strokeStyle = c.text; ctx.lineWidth = 2.4; ctx.beginPath();
  deciles.forEach((d, k) => { const px = plot.px(d.x), py = plot.py(d.y); if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
  ctx.stroke();
  for (const d of deciles) { ctx.fillStyle = c.panel; ctx.strokeStyle = c.text; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(plot.px(d.x), plot.py(d.y), 3.6, 0, 6.2832); ctx.fill(); ctx.stroke(); }
  ctx.restore();
  demogHit = { sx, sy, idx:order };
  const imputed = idx.filter(i => store.imputed[i]).length;
  const outside = idx.filter(i => xt[i] < xd[0] || xt[i] > xd[1] || ys[i] < yd[0] || ys[i] > yd[1]).length;
  $('#sh-demog-stats').textContent = `Line: ${state.weighted ? 'vote-weighted' : 'unweighted'} mean shift within deciles of the x measure, each decile holding a tenth of the ${state.weighted ? 'two-party votes' : 'places'}. ${idx.length.toLocaleString('en-US')} ${levelInfo[store.level].noun}${imputed ? `; ${imputed.toLocaleString('en-US')} with estimated demographics ${imputed === 1 ? 'is' : 'are'} hollow` : ''}${outside ? `; ${outside.toLocaleString('en-US')} beyond the axis limits not drawn` : ''}.`;
  attachHover(canvas, () => demogHit, i => `<strong>${escapeHTML(placeName(i))}</strong>${pairTip(i, state.from, state.to, ev)}<br>${escapeHTML(label)}: ${key === 'med_income' ? `$${count(raw[i])}` : key === 'density' ? `${count(raw[i])} per sq mi` : pct(Math.min(1, Math.max(0, raw[i])))}${store.imputed[i] ? '<br>Demographics estimated from neighboring precincts.' : ''}`, i => openPlace(store.level, i));
}

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
  let boxes = null, view = null;
  if (tableState.view) { boxes = await boxesFor(store.level); view = viewBounds(); }
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
  syncControls();
  const ev = evaluate(store, state.from, state.to);
  renderHeader(ev, levelInfo[store.level].noun);
  renderSummary(ev);
  if (state.view === 'xy') drawXY(); else if (state.view === 'demog') drawDemog(); else { await drawTable(); if (request !== drawing) return; }
}
async function load() {
  if (loading) return loading;
  const status = $('#sh-status');
  loading = (async () => {
    status.hidden = false; status.textContent = 'Loading precinct data…';
    try {
      [store, counties] = await Promise.all([ensureStore(state.level), countyNames()]);
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
  loading = null; store = null;
  await load();
}
function init() {
  build(); syncControls();
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
  $('#sh-demog').addEventListener('change', e => set({ demog:e.target.value }, 'view'));
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
  window.addEventListener('compare-change', () => { tableState.page = 0; if (!panel.hidden) { load(); redraw(); } });
  window.addEventListener('view-change', () => { if (!panel.hidden && state.view === 'table' && tableState.view) drawTable(); });
  window.addEventListener('display-change', () => redraw());
  window.addEventListener('panel-layout', () => { if (!panel.hidden) { load(); redraw(); } });
  new ResizeObserver(() => { if (!panel.hidden) redraw(); }).observe($('#sh-views'));
  if (!panel.hidden) load();
}
init();
