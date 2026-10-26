import { scaleLinear } from 'd3-scale';
import { escapeHTML } from './data.js';
import { fmt, fmtTick, fmtDelta, slopeUnit, withMargin } from './measures.js';

// Canvas scatter shared by the Early vote and Precinct shifts panels. Binned means by default (20 equal-count x bins, each a
// weighted mean of y with a 90% band) over a faint density of every unit; a points view draws up to 3,000 units. A weighted
// linear fit and its r are shown when at least 30 units have x, y and a weight. Units with no value are left out everywhere.
const POINT_CAP = 3000, BINS = 20, MIN_FIT = 30;
const leanRamp = scaleLinear().domain([0, .5, 1]).range(['#b2453c', '#9aa5a8', '#1d6483']).clamp(true);
const seqRamp = scaleLinear().domain([0, .25, .5, .75, 1]).range(['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725']).clamp(true);
const dark = () => document.documentElement.dataset.layout === 'dark';
const ink = () => dark() ? { text:'#e5edf2', muted:'#acbfcb', grid:'#364a5b', fit:'#f4d27a', panel:'#1b2937', none:'#5b6670', dot:'rgba(200,215,225,.10)' } : { text:'#1b282d', muted:'#64767b', grid:'#e3e9e8', fit:'#8a5a00', panel:'#ffffff', none:'#b6bfc1', dot:'rgba(40,60,65,.08)' };
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))] : NaN;

// Weighted fit of y on x over the given indices: slope, intercept and weighted correlation.
export function weightedFit(x, y, w, idx) {
  let sw = 0, mx = 0, my = 0;
  for (const i of idx) { sw += w[i]; mx += w[i] * x[i]; my += w[i] * y[i]; }
  if (!(sw > 0)) return null;
  mx /= sw; my /= sw;
  let sxx = 0, syy = 0, sxy = 0;
  for (const i of idx) { const dx = x[i] - mx, dy = y[i] - my; sxx += w[i] * dx * dx; syy += w[i] * dy * dy; sxy += w[i] * dx * dy; }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return { slope:sxy / sxx, intercept:my - sxy / sxx * mx, r:sxy / Math.sqrt(sxx * syy), n:idx.length };
}

export function createXYPlot(host, { onPick, onBrush, onHover }) {
  host.classList.add('xy');
  host.innerHTML = '<canvas class="xy-canvas"></canvas><svg class="xy-overlay" aria-hidden="true"></svg><div class="chart-tooltip" hidden></div>';
  const canvas = host.querySelector('canvas'), overlay = host.querySelector('.xy-overlay'), tip = host.querySelector('.chart-tooltip');
  let state = null, hits = [], frame = null, drag = null;

  function draw(d) {
    state = d;
    const width = Math.max(240, host.clientWidth || 320), height = d.height || 300, ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    overlay.setAttribute('viewBox', `0 0 ${width} ${height}`); overlay.innerHTML = '';
    const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const c = ink(), m = { top:8, right:10, bottom:34, left:width < 360 ? 42 : 50 }, pad = 8;
    const { x, y, w } = d, idx = [];
    for (let i = 0; i < d.n; i++) if (Number.isFinite(x[i]) && Number.isFinite(y[i])) idx.push(i);
    if (idx.length < 3) {
      ctx.fillStyle = c.muted; ctx.font = "12px 'DM Sans', system-ui, sans-serif"; ctx.textAlign = 'center';
      ctx.fillText(`Too few ${d.noun} have both values.`, width / 2, height / 2);
      hits = []; frame = null; d.onStats?.({ n:idx.length, fit:null }); return;
    }
    const xs = idx.map(i => x[i]).sort((a, b) => a - b), ys = idx.map(i => y[i]).sort((a, b) => a - b);
    const span = (s, lo, hi) => { let a = quantile(s, lo), b = quantile(s, hi); if (!(b > a)) { a -= .5 * Math.abs(a || 1); b += .5 * Math.abs(b || 1); } const p = (b - a) * .04; return [a - p, b + p]; };
    const xd = span(xs, .005, .995), yd = span(ys, .005, .995);
    const X0 = m.left + pad, X1 = width - m.right - pad, Y0 = height - m.bottom - pad, Y1 = m.top + pad;
    const sx = v => X0 + (Math.max(xd[0], Math.min(xd[1], v)) - xd[0]) / (xd[1] - xd[0]) * (X1 - X0);
    const sy = v => Y0 - (Math.max(yd[0], Math.min(yd[1], v)) - yd[0]) / (yd[1] - yd[0]) * (Y0 - Y1);
    frame = { sx, sy, X0, X1, Y0, Y1, xd, yd, width, height, m };
    // Frame, grid and ticks.
    ctx.font = "10px 'DM Sans', system-ui, sans-serif"; ctx.lineWidth = 1;
    const xt = scaleLinear().domain(xd).ticks(width < 360 ? 4 : 6), yt = scaleLinear().domain(yd).ticks(5);
    for (const t of xt) { ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(sx(t), m.top); ctx.lineTo(sx(t), height - m.bottom); ctx.stroke(); ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.fillText(fmtTick(d.xm, t), sx(t), height - m.bottom + 12); }
    for (const t of yt) { ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(m.left, sy(t)); ctx.lineTo(width - m.right, sy(t)); ctx.stroke(); ctx.fillStyle = c.muted; ctx.textAlign = 'right'; ctx.fillText(fmtTick(d.ym, t), m.left - 4, sy(t) + 3); }
    if (d.yRef != null && d.yRef >= yd[0] && d.yRef <= yd[1]) { ctx.strokeStyle = c.muted; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(m.left, sy(d.yRef)); ctx.lineTo(width - m.right, sy(d.yRef)); ctx.stroke(); ctx.setLineDash([]); }
    ctx.strokeStyle = c.grid; ctx.strokeRect(m.left, m.top, width - m.left - m.right, height - m.top - m.bottom);
    ctx.fillStyle = c.muted; ctx.font = "600 10px 'DM Sans', system-ui, sans-serif"; ctx.textAlign = 'center';
    ctx.fillText(clip(ctx, d.xm.label, width - 20), (m.left + width - m.right) / 2, height - 4);
    ctx.save(); ctx.translate(11, (m.top + height - m.bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(clip(ctx, d.ym.label, height - m.top - m.bottom), 0, 0); ctx.restore();
    // Colour: forecast lean on its own red-grey-blue scale; any other measure on a sequential scale over its 2nd-98th percentile.
    const cv = d.c, cIdx = cv ? idx.filter(i => Number.isFinite(cv[i])) : [];
    const cs = cIdx.map(i => cv[i]).sort((a, b) => a - b), clo = quantile(cs, .02), chi = quantile(cs, .98);
    const colorOf = v => !Number.isFinite(v) ? c.none : d.cm?.unit === 'prob' ? leanRamp(v) : seqRamp(chi > clo ? (v - clo) / (chi - clo) : .5);
    const wv = i => Number.isFinite(w?.[i]) && w[i] > 0 ? w[i] : 0;
    const ws = idx.map(wv).filter(v => v > 0).sort((a, b) => a - b), wMax = quantile(ws, .98) || 1;
    ctx.save(); ctx.beginPath(); ctx.rect(m.left, m.top, width - m.left - m.right, height - m.top - m.bottom); ctx.clip();
    hits = [];
    const pts = idx.filter(i => wv(i) > 0 || !w);
    if (d.mode === 'points') {
      const shown = [...idx].sort((a, b) => wv(b) - wv(a)).slice(0, POINT_CAP);
      for (const i of [...shown].reverse()) {
        const px = sx(x[i]), py = sy(y[i]), r = d.sizeByWeight ? 1.5 + 4.5 * Math.sqrt(Math.min(1, wv(i) / wMax)) : 2.5;
        ctx.globalAlpha = .6; ctx.fillStyle = colorOf(cv?.[i]); ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832); ctx.fill();
        hits.push({ i, x:px, y:py, r });
      }
      d.shown = shown.length;
    } else {
      // Faint density of every unit behind the bins.
      ctx.fillStyle = c.dot; for (const i of idx) ctx.fillRect(sx(x[i]) - 1, sy(y[i]) - 1, 2, 2);
      const order = pts.slice().sort((a, b) => x[a] - x[b]), per = order.length / BINS, bins = [];
      for (let b = 0; b < BINS; b++) {
        const part = order.slice(Math.round(b * per), Math.round((b + 1) * per)).filter(i => !w || wv(i) > 0);
        if (part.length < 2) continue;
        let sw = 0, sw2 = 0, mx = 0, my = 0, mc = 0, swc = 0;
        for (const i of part) { const wi = w ? wv(i) : 1; sw += wi; sw2 += wi * wi; mx += wi * x[i]; my += wi * y[i]; if (cv && Number.isFinite(cv[i])) { mc += wi * cv[i]; swc += wi; } }
        mx /= sw; my /= sw;
        let ss = 0; for (const i of part) { const wi = w ? wv(i) : 1; ss += wi * wi * (y[i] - my) ** 2; }
        const se = Math.sqrt(ss) / sw;
        bins.push({ n:part.length, mx, my, lo:my - 1.645 * se, hi:my + 1.645 * se, mc:swc > 0 ? mc / swc : NaN, xmin:x[part[0]], xmax:x[part.at(-1)] });
      }
      ctx.globalAlpha = 1; ctx.strokeStyle = c.muted; ctx.lineWidth = 1.2; ctx.beginPath();
      bins.forEach((b, k) => { if (k) ctx.lineTo(sx(b.mx), sy(b.my)); else ctx.moveTo(sx(b.mx), sy(b.my)); }); ctx.stroke();
      for (const b of bins) {
        ctx.strokeStyle = c.text; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(sx(b.mx), sy(b.lo)); ctx.lineTo(sx(b.mx), sy(b.hi)); ctx.stroke();
        ctx.fillStyle = colorOf(b.mc); ctx.strokeStyle = c.panel; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(sx(b.mx), sy(b.my), 4.6, 0, 6.2832); ctx.fill(); ctx.stroke();
        hits.push({ bin:b, x:sx(b.mx), y:sy(b.my), r:6 });
      }
      d.shown = bins.length;
    }
    // Weighted fit over every unit with x, y and a weight.
    const fit = pts.length >= MIN_FIT ? weightedFit(x, y, w || new Float64Array(d.n).fill(1), pts) : null;
    if (fit) { ctx.globalAlpha = 1; ctx.strokeStyle = c.fit; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx(xd[0]), sy(fit.intercept + fit.slope * xd[0])); ctx.lineTo(sx(xd[1]), sy(fit.intercept + fit.slope * xd[1])); ctx.stroke(); }
    // Selected and hovered units, ringed wherever they sit.
    for (const i of d.marked || []) { if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue; ctx.globalAlpha = 1; for (const [s, lw] of [[c.panel, 4], [c.text, 2]]) { ctx.strokeStyle = s; ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(sx(x[i]), sy(y[i]), 7, 0, 6.2832); ctx.stroke(); } }
    for (const i of d.brushed || []) { if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue; ctx.globalAlpha = .9; ctx.strokeStyle = '#c98a00'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(sx(x[i]), sy(y[i]), 3.5, 0, 6.2832); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1;
    const su = slopeUnit(d.xm);
    d.onStats?.({ n:pts.length, fit, slopeText:fit ? `r = ${fit.r.toFixed(2)} · ${fmtDelta(d.ym, fit.slope * su.step)} ${su.text}` : null, colorRange:cIdx.length ? [clo, chi] : null });
  }
  function clip(ctx, text, max) { if (ctx.measureText(text).width <= max) return text; let t = text; while (t.length > 4 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1); return `${t}…`; }
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const nearest = (mx, my) => { let best = null, bd = 100; for (const h of hits) { const dd = (h.x - mx) ** 2 + (h.y - my) ** 2; if (dd < Math.max(bd, 0) && dd <= (h.r + 6) ** 2) { bd = dd; best = h; } } return best; };
  function tipHTML(h) {
    const d = state;
    if (h.bin) return `<strong>${h.bin.n.toLocaleString('en-US')} ${escapeHTML(d.noun)}</strong>${escapeHTML(d.xm.label)}: ${escapeHTML(fmt(d.xm, h.bin.xmin))} to ${escapeHTML(fmt(d.xm, h.bin.xmax))}<br>Mean ${escapeHTML(d.ym.label)}: ${escapeHTML(fmt(d.ym, h.bin.my))}<br>90% band of the mean: ${escapeHTML(fmt(d.ym, h.bin.lo))} to ${escapeHTML(fmt(d.ym, h.bin.hi))}${d.cm && Number.isFinite(h.bin.mc) ? `<br>Mean ${escapeHTML(d.cm.label)}: ${escapeHTML(fmt(d.cm, h.bin.mc))}` : ''}`;
    const i = h.i, line = (e, arr, moe) => `${escapeHTML(e.label)}: ${escapeHTML(withMargin(e, arr[i], moe?.[i]))}${e.tract ? ' <span class="mpick-badge">tract-level estimate</span>' : ''}`;
    return `<strong>${escapeHTML(d.labels[i])}</strong>${line(d.xm, d.x, d.xMoe)}<br>${line(d.ym, d.y, d.yMoe)}${d.cm && d.c ? `<br>${line(d.cm, d.c, d.cMoe)}` : ''}`;
  }
  function place(h) {
    tip.innerHTML = tipHTML(h); tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight, W = host.clientWidth;
    tip.style.left = `${h.x + 12 + tw > W ? Math.max(4, h.x - tw - 12) : h.x + 12}px`;
    tip.style.top = `${Math.max(4, Math.min(canvas.clientHeight - th - 4, h.y - th / 2))}px`;
  }
  canvas.addEventListener('pointerdown', e => { if (!frame || e.button !== 0) return; canvas.setPointerCapture(e.pointerId); drag = { start:local(e), moved:false }; });
  canvas.addEventListener('pointermove', e => {
    const [mx, my] = local(e);
    if (drag) {
      if (Math.hypot(mx - drag.start[0], my - drag.start[1]) > 4) drag.moved = true;
      if (drag.moved) { const [a, b] = drag.start; overlay.innerHTML = `<rect x="${Math.min(a, mx)}" y="${Math.min(b, my)}" width="${Math.abs(mx - a)}" height="${Math.abs(my - b)}"/>`; tip.hidden = true; return; }
    }
    const h = nearest(mx, my);
    canvas.style.cursor = h ? 'pointer' : 'crosshair';
    if (!h) { tip.hidden = true; onHover?.(null); return; }
    place(h); onHover?.(h.bin ? null : h.i);
  });
  canvas.addEventListener('pointerup', e => {
    const d = drag; drag = null; overlay.innerHTML = '';
    if (!d || !frame) return;
    const [mx, my] = local(e);
    if (!d.moved) { const h = nearest(mx, my); if (h && !h.bin) onPick?.(h.i); return; }
    // Brush: every unit whose position falls in the box, drawn or not.
    const [a, b] = d.start, x0 = Math.min(a, mx), x1 = Math.max(a, mx), y0 = Math.min(b, my), y1 = Math.max(b, my), out = [];
    for (let i = 0; i < state.n; i++) { if (!Number.isFinite(state.x[i]) || !Number.isFinite(state.y[i])) continue; const px = frame.sx(state.x[i]), py = frame.sy(state.y[i]); if (px >= x0 && px <= x1 && py >= y0 && py <= y1) out.push(i); }
    onBrush?.(out);
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) { tip.hidden = true; onHover?.(null); } });
  return { draw, redraw:() => state && draw(state), get state() { return state; } };
}

// Colour legend for the panel: the lean scale or the sequential one with its range.
export function colorLegend(cm, range) {
  if (!cm) return '';
  if (cm.unit === 'prob') return `<span class="xy-ramp lean"></span><span>${escapeHTML(cm.label)}: Paxton favored to Talarico favored</span>`;
  return range ? `<span class="xy-ramp seq"></span><span>${escapeHTML(cm.label)}: ${escapeHTML(fmt(cm, range[0]))} to ${escapeHTML(fmt(cm, range[1]))}</span>` : '';
}
