import { scaleLinear, scaleTime } from 'd3-scale';
import { line, area, curveMonotoneX } from 'd3-shape';
import { pct, signed, escapeHTML } from './data.js';
import { marginColor, partyColor } from './map.js';

let track = [], polls = [], combined = null, baselines = new Map(), current = 'mean';
// The chart draws into the panel and, when open, the expanded overlay; both share layer and range state.
const roots = ['#trend-chart', '#trend-chart-big'].map(s => document.querySelector(s)).filter(Boolean);
const layerKeys = ['dots','avg','fc','fund','fsens'];
const layers = { dots:true, avg:true, fc:true, fund:true, fsens:false };
const defaultFlags = '11110';
let range = '6m';
let maxInfluence = 0, hintOpen = false;
window.addEventListener('display-change', () => drawAll());
let has = { traj:false, sens:false, approval:false };
const date = value => new Date(`${value}T00:00:00Z`);
const dateLabel = value => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC',month:'short',day:'numeric',year:'numeric' }).format(value);
const axisDate = (value, short) => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC',month:'short',...(short ? {} : { year:'2-digit' }) }).format(value);
const format = (value, shift) => shift ? signed(value) : pct(value);
const finite = v => v !== '' && v != null && v !== 'NA' && Number.isFinite(+v);

// Layer and range state live in the URL: ct = 0/1 flags (dots, average, projection, adopted fundamentals, approval sensitivity), cx=all for the full series.
const params = new URLSearchParams(location.search);
const flags = params.get('ct');
if (flags && /^[01]{4,5}$/.test(flags)) layerKeys.forEach((key, i) => { if (i < flags.length) layers[key] = flags[i] === '1'; });
if (params.get('cx') === 'all') range = 'all';

function writeState() {
  const url = new URL(location.href);
  const value = layerKeys.map(key => layers[key] ? '1' : '0').join('');
  if (value === defaultFlags) url.searchParams.delete('ct'); else url.searchParams.set('ct', value);
  if (range === 'all') url.searchParams.set('cx', 'all'); else url.searchParams.delete('cx');
  history.replaceState(null, '', url);
}

function syncControls() {
  for (const chip of document.querySelectorAll('[data-chart-layer]')) chip.setAttribute('aria-pressed', String(!!layers[chip.dataset.chartLayer]));
  for (const button of document.querySelectorAll('[data-chart-range]')) button.setAttribute('aria-pressed', String(button.dataset.chartRange === range));
}

for (const chip of document.querySelectorAll('[data-chart-layer]')) chip.addEventListener('click', () => {
  layers[chip.dataset.chartLayer] = !layers[chip.dataset.chartLayer];
  writeState(); syncControls(); drawAll();
});
for (const button of document.querySelectorAll('[data-chart-range]')) button.addEventListener('click', () => {
  range = button.dataset.chartRange;
  writeState(); syncControls(); drawAll();
});
syncControls();

const dialog = document.querySelector('#chart-dialog');
document.querySelector('#chart-expand')?.addEventListener('click', () => { dialog.showModal(); drawAll(); });
dialog?.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
dialog?.querySelector('.chart-dialog-close')?.addEventListener('click', () => dialog.close());

export function initChart(trackRows, pollRows, headline, shifts) {
  track = trackRows.map(row => ({ ...row, time:date(row.date) }));
  // Each poll sits at the midpoint of its field dates; the whisker spans field_start to end_date.
  polls = pollRows.map(row => {
    const s0 = date(row.field_start || row.end_date), e0 = date(row.end_date);
    return { ...row, start:s0, finish:e0, time:new Date((+s0 + +e0) / 2) };
  });
  maxInfluence = Math.max(...polls.map(row => +row.influence).filter(Number.isFinite), 0);
  combined = headline.find(row => row.component === 'combined');
  const cols = trackRows.columns || Object.keys(trackRows[0] || {});
  has = { traj:cols.includes('trajectory_mean'), sens:['fund_appr_mean','fund_appr_lo95','fund_appr_hi95'].every(c => cols.includes(c)), approval:cols.includes('tx_net_approval'), weight:cols.includes('fund_weight'), fund:cols.includes('fund_mean') };
  for (const chip of document.querySelectorAll('[data-chart-layer="fsens"]')) chip.hidden = !has.sens;
  for (const chip of document.querySelectorAll('[data-chart-layer="fund"]')) chip.hidden = !has.fund;
  const weights = track.filter(row => finite(row.fund_weight));
  const readout = document.querySelector('#fund-weight-readout');
  if (readout) readout.textContent = weights.length ? `Fundamentals weight ${pct(weights[0].fund_weight,0)} → ${pct(weights.at(-1).fund_weight,0)}` : '';
  baselines = new Map(shifts.filter(row => row.component === 'combined').map(row => [row.baseline,row.label]));
  document.querySelector('#poll-summary').textContent = `Poll ledger · ${polls.length} polls`;
  renderChart('mean');
  const observer = new ResizeObserver(entries => { for (const entry of entries) if (entry.target.clientWidth > 100) draw(entry.target); });
  for (const root of roots) observer.observe(root);
}

export function renderChart(measure) {
  current = measure.startsWith('shift_') ? measure : 'mean';
  const title = current === 'mean' ? 'Polling average and forecast' : `Shift vs ${baselines.get(current.slice(6)) || current.slice(6)}`;
  for (const el of document.querySelectorAll('.trend-title-text')) el.textContent = title;
  for (const chip of document.querySelectorAll('[data-chart-layer="fc"],[data-chart-layer="fund"],[data-chart-layer="fsens"],[data-chart-layer="dots"]')) chip.disabled = current !== 'mean';
  drawAll();
}

function drawAll() {
  if (!track.length) return;
  for (const root of roots) if (root.clientWidth > 100) draw(root);
}

const has_ = v => v !== '' && v != null && v !== 'NA';
const shortDate = d => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC', month:'short', day:'numeric' }).format(d);
function pollTooltip(p) {
  const dates = +p.finish > +p.start ? `${shortDate(p.start)}–${dateLabel(p.finish)}` : dateLabel(p.finish);
  const m = +p.margin;
  const lead = m > 0 ? `Talarico +${+m.toFixed(1)}` : m < 0 ? `Paxton +${+Math.abs(m).toFixed(1)}` : 'Tied';
  const third = p.brown_named === 'TRUE' ? 'Brown' : 'Other';
  return `<strong>${escapeHTML(p.pollster)}</strong><br>${escapeHTML(dates)}<br>n=${escapeHTML(p.n)}${has_(p.population) ? ` ${escapeHTML(p.population)}` : ''}${has_(p.mode) ? ` · ${escapeHTML(p.mode)}` : ''}
    <br>Talarico ${escapeHTML(p.talarico)} · Paxton ${escapeHTML(p.paxton)} · ${third} ${escapeHTML(has_(p.other) ? p.other : '—')}${has_(p.undecided) ? ` · Undecided ${escapeHTML(p.undecided)}` : ''}
    <br>Margin: ${lead}${p.brown_named === 'TRUE' ? '<br>Brown named on ballot' : ''}
    ${Number.isFinite(+p.influence) ? `<br>${(100 * +p.influence).toFixed(1)}% of current average` : ''}${p.lean === 'D' || p.lean === 'R' ? `<br>Partisan sponsor (${p.lean === 'D' ? 'Democratic' : 'Republican'})` : ''}`;
}

// Pick a spot for the Election Day label that stays inside the plot and clear of dots and lines.
function placeLabel(text, candidates, obstacles, bounds) {
  const w = text.length * 5.7 + 6, h = 13;
  const box = c => c.anchor === 'end' ? [c.x - w, c.y - h + 3, c.x, c.y + 3] : [c.x, c.y - h + 3, c.x + w, c.y + 3];
  const fits = ([l, t, r, b]) => l >= bounds.left && r <= bounds.right && t >= bounds.top && b <= bounds.bottom;
  const clear = ([l, t, r, b]) => !obstacles.some(o => o.x + (o.r || 1) >= l && o.x - (o.r || 1) <= r && o.y + (o.r || 1) >= t && o.y - (o.r || 1) <= b);
  return candidates.find(c => fits(box(c)) && clear(box(c))) || candidates.find(c => fits(box(c))) || candidates[0];
}

function draw(root) {
  const width = Math.max(220, root.clientWidth), height = Math.max(200, root.clientHeight || 300);
  const margin = { top:10, right:10, bottom:22, left:34 };
  const right = width - margin.right, bottom = height - margin.bottom;
  const shift = current !== 'mean';
  const show = { dots:layers.dots && !shift, avg:layers.avg, fc:layers.fc && !shift, fund:layers.fund && !shift && has.fund, fsens:layers.fsens && !shift && has.sens };
  const valid = track.filter(row => finite(row[current]));
  if (!valid.length) { root.textContent = 'No trend available for this measure.'; return; }
  const end = valid.at(-1).time;
  // "All" starts at the earliest poll's field start so every poll is shown, even one fielded before the average begins.
  const firstPoll = !shift && polls.length ? Math.min(...polls.map(row => +row.start)) : +valid[0].time;
  const start = range === 'all' ? new Date(Math.min(+valid[0].time, firstPoll)) : new Date(Math.max(+valid[0].time, +end - 183 * 864e5));
  const inView = row => row.time >= start;
  const lastObserved = valid.findLastIndex(row => row.projected !== 'TRUE');
  const observed = valid.slice(0, lastObserved + 1);
  const projected = valid.slice(Math.max(0, lastObserved));
  // The projected path: the published trajectory if present, otherwise the older forecast columns.
  const [fm, flo, fhi] = has.traj ? ['trajectory_mean','trajectory_lo95','trajectory_hi95'] : ['forecast_mean','forecast_lo95','forecast_hi95'];
  const forecast = shift ? [] : track.filter(row => finite(row[fm]));
  const sens = show.fsens ? track.filter(row => finite(row.fund_appr_mean)) : [];
  const fundMean = track.find(row => finite(row.fund_mean))?.fund_mean;
  const visiblePolls = show.dots ? polls.filter(row => row.finish >= start) : [];
  const x = scaleTime().domain([start, end]).range([margin.left, right]);
  // Fit the y range to what is drawn in the visible window, plus a small margin.
  const edges = [];
  const shown = valid.filter(inView);
  if (show.avg) edges.push(...shown.flatMap(row => [+row[current] - 1.96 * +row.se, +row[current] + 1.96 * +row.se]));
  else edges.push(...shown.map(row => +row[current]));
  edges.push(...visiblePolls.map(row => +row.talarico_2p));
  if (show.fc) edges.push(...forecast.flatMap(row => [+row[flo], +row[fhi]]));
  if (show.fsens) edges.push(...sens.filter(inView).flatMap(row => [+row.fund_appr_lo95, +row.fund_appr_hi95]));
  if (show.fund && finite(fundMean)) edges.push(+fundMean);
  const low = Math.min(...edges), high = Math.max(...edges), pad = Math.max(.003, (high - low) * .04);
  const y = scaleLinear().domain([low - pad, high + pad]).range([bottom, margin.top]);
  const step = (high - low) * 100 > 8 ? .02 : .01;
  const tickValues = [];
  for (let v = Math.ceil((low - pad) / step - 1e-9) * step; v <= high + pad + 1e-9; v += step) tickValues.push(+v.toFixed(4));
  const avgLine = line().x(row => x(row.time)).y(row => y(+row[current])).curve(curveMonotoneX);
  const band = area().x(row => x(row.time)).y0(row => y(+row[current] - 1.96 * +row.se)).y1(row => y(+row[current] + 1.96 * +row.se)).curve(curveMonotoneX);
  const fcLine = line().x(row => x(row.time)).y(row => y(+row[fm])).curve(curveMonotoneX);
  const fcBand = area().x(row => x(row.time)).y0(row => y(+row[flo])).y1(row => y(+row[fhi])).curve(curveMonotoneX);
  const sensLine = line().x(row => x(row.time)).y(row => y(+row.fund_appr_mean));
  const sensBand = area().x(row => x(row.time)).y0(row => y(+row.fund_appr_lo95)).y1(row => y(+row.fund_appr_hi95));
  const reference = shift ? 0 : .5;
  const tickText = v => shift ? `${v >= 0 ? '+' : ''}${Math.round(v * 100)}` : `${Math.round(v * 100)}%`;
  const ticks = tickValues.map(v => `<g><line class="chart-grid${Math.abs(v - reference) < 1e-9 ? ' center' : ''}" x1="${margin.left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${margin.left - 5}" y="${y(v) + 3}" text-anchor="end">${escapeHTML(tickText(v))}</text></g>`).join('');
  const refLine = y(reference) >= margin.top && y(reference) <= bottom ? `<line class="chart-reference" x1="${margin.left}" x2="${right}" y1="${y(reference)}" y2="${y(reference)}"/>` : '';
  const timeTicks = x.ticks(width < 360 ? 3 : width < 560 ? 5 : 7).map(v => `<text class="chart-axis" x="${x(v)}" y="${height - 6}" text-anchor="middle">${axisDate(v, range !== 'all')}</text>`).join('');
  const windowStart = forecast.length ? x(forecast[0].time) : null;
  const shade = show.fc && windowStart != null ? `<rect class="chart-window" x="${windowStart}" y="${margin.top}" width="${right - windowStart}" height="${bottom - margin.top}"/>` : '';
  const avg = show.avg ? `<path class="chart-band" d="${band(observed) || ''}"/><path class="chart-band projected" d="${band(projected) || ''}"/>
    <path class="chart-line" d="${avgLine(observed) || ''}"/><path class="chart-line projected" d="${avgLine(projected) || ''}"/>` : '';
  let fund = show.fund && finite(fundMean) ? `<line class="chart-fund" x1="${margin.left}" x2="${right}" y1="${y(+fundMean)}" y2="${y(+fundMean)}"/>` : '';
  if (sens.length) {
    // Dotted where approval_held is true: the last Civiqs reading carried forward.
    const firstHeld = sens.findIndex(row => row.approval_held === 'TRUE');
    const live = firstHeld < 0 ? sens : sens.slice(0, firstHeld + 1);
    const held = firstHeld < 0 ? [] : sens.slice(Math.max(0, firstHeld - 1));
    fund += `<path class="chart-sens-band" d="${sensBand(sens) || ''}"/><path class="chart-sens-line" d="${sensLine(live) || ''}"/>${held.length ? `<path class="chart-sens-line held" d="${sensLine(held) || ''}"/>` : ''}`;
  }
  // Poll marks: colour = margin, area ∝ n, circle = LV / diamond = RV, opacity = influence, dashed ring = partisan sponsor.
  const dotR = row => 2.6 + 4.4 * (Math.sqrt(Math.min(1800, Math.max(550, +row.n))) - Math.sqrt(550)) / (Math.sqrt(1800) - Math.sqrt(550));
  const markOpacity = row => maxInfluence > 0 && Number.isFinite(+row.influence) ? Math.max(.2, +row.influence / maxInfluence) : .5;
  const shape = (cx, cy, rr, rv, attrs) => rv
    ? `<path ${attrs} d="M${cx},${cy - rr * 1.25}L${cx + rr * 1.25},${cy}L${cx},${cy + rr * 1.25}L${cx - rr * 1.25},${cy}Z"/>`
    : `<circle ${attrs} cx="${cx}" cy="${cy}" r="${rr}"/>`;
  const dots = visiblePolls.map((row, i) => {
    const cx = x(row.time), cy = y(+row.talarico_2p), rr = dotR(row), rv = row.population === 'RV';
    const fill = marginColor(+row.margin);
    const whisker = +row.finish > +row.start ? `<line class="poll-whisker" x1="${x(row.start)}" x2="${x(row.finish)}" y1="${cy}" y2="${cy}" stroke="${fill}"/>` : '';
    const ring = row.lean === 'D' || row.lean === 'R' ? shape(cx, cy, rr + 2.6, rv, `class="poll-ring" stroke="${partyColor(row.lean)}"`) : '';
    return `<g class="chart-poll" data-i="${i}" data-poll-id="${escapeHTML(row.poll_id || '')}" style="opacity:${markOpacity(row).toFixed(3)}">${whisker}${ring}${shape(cx, cy, rr, rv, `class="poll-mark" fill="${fill}"`)}</g>`;
  }).join('');
  let fc = '';
  if (show.fc && forecast.length) {
    const last = forecast.at(-1);
    const ex = x(last.time), ey = combined ? y(+combined.mean) : y(+last[fm]);
    const text = combined ? `Forecast ${pct(combined.mean)} · ${pct(combined.p_talarico_win, 0)} win prob` : '';
    const obstacles = [
      ...visiblePolls.map(row => ({ x:x(row.time), y:y(+row.talarico_2p), r:dotR(row) + 1 })),
      ...(show.avg ? shown : []).map(row => ({ x:x(row.time), y:y(+row[current]), r:2 })),
      ...forecast.map(row => ({ x:x(row.time), y:y(+row[fm]), r:2 })),
      ...(show.fund && finite(fundMean) ? x.ticks(40).map(t => ({ x:x(t), y:y(+fundMean), r:2 })) : []),
      ...sens.filter(inView).map(row => ({ x:x(row.time), y:y(+row.fund_appr_mean), r:2 })),
      { x:ex, y:ey, r:6 },
      // The "?" legend button sits over the plot's top-right corner.
      { x:width - 14, y:14, r:12 },
    ];
    const top = y(Math.max(...forecast.map(row => +row[fhi]))), bot = y(Math.min(...forecast.map(row => +row[flo])));
    const candidates = [
      { x:ex - 8, y:Math.min(top - 6, ey - 10), anchor:'end' }, { x:ex - 8, y:Math.max(bot + 14, ey + 18), anchor:'end' },
      { x:ex - 8, y:margin.top + 11, anchor:'end' }, { x:ex - 8, y:bottom - 6, anchor:'end' },
      { x:(windowStart ?? ex) - 8, y:margin.top + 11, anchor:'end' }, { x:(windowStart ?? ex) - 8, y:bottom - 6, anchor:'end' },
      { x:margin.left + 4, y:margin.top + 11, anchor:'start' }, { x:margin.left + 4, y:bottom - 6, anchor:'start' },
    ];
    const at = placeLabel(text, candidates, obstacles, { left:margin.left, right, top:margin.top, bottom });
    fc = `<path class="chart-fc-band" d="${fcBand(forecast) || ''}"/><path class="chart-fc-line" d="${fcLine(forecast) || ''}"/>
      <circle class="chart-fc-marker" cx="${ex}" cy="${ey}" r="4.5"/>
      <text class="chart-fc-label" x="${at.x}" y="${at.y}" text-anchor="${at.anchor}">${escapeHTML(text)}</text>`;
  }
  const clip = `clip-${root.id}`;
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(document.querySelector('.trend-title-text')?.textContent || 'Polling chart')}">
    <defs><clipPath id="${clip}"><rect x="${margin.left}" y="${margin.top - 6}" width="${right - margin.left + 6}" height="${bottom - margin.top + 6}"/></clipPath></defs>
    ${ticks}${refLine}<g clip-path="url(#${clip})">${shade}${fund}<g class="poll-marks">${dots}</g>${avg}${fc.replace(/<text[\s\S]*$/, '')}</g>${fc.match(/<text[\s\S]*$/)?.[0] || ''}${timeTicks}
    <line class="chart-cursor" x1="0" x2="0" y1="${margin.top}" y2="${bottom}" visibility="hidden"/><circle class="chart-focus" r="4" visibility="hidden"/>
  </svg><div class="chart-tooltip" hidden></div>
  <button type="button" class="chart-help" aria-expanded="${hintOpen}" aria-label="How to read the poll marks">?</button>
  <div class="chart-help-pop" ${hintOpen ? '' : 'hidden'}>
    <div><b>Colour</b> margin, blue Talarico ahead, red Paxton ahead (±8 pts)</div>
    <div><b>Size</b> sample size</div>
    <div><b>Circle / diamond</b> likely / registered voters</div>
    <div><b>Faded</b> less weight in today's average</div>
    <div><b>Dashed ring</b> partisan sponsor</div>
    <div><b>Whisker</b> field dates</div>
  </div>`;
  const help = root.querySelector('.chart-help'), pop = root.querySelector('.chart-help-pop');
  help.addEventListener('click', () => { hintOpen = !hintOpen; pop.hidden = !hintOpen; help.setAttribute('aria-expanded', String(hintOpen)); });
  const svg = root.querySelector('svg'), tooltip = root.querySelector('.chart-tooltip');
  const cursor = root.querySelector('.chart-cursor'), focus = root.querySelector('.chart-focus');
  const circles = [...root.querySelectorAll('.chart-poll')];
  const marksGroup = root.querySelector('.poll-marks');
  const hide = () => { tooltip.hidden = true; cursor.setAttribute('visibility','hidden'); focus.setAttribute('visibility','hidden'); circles.forEach(c => c.classList.remove('active')); marksGroup?.classList.remove('dimmed'); };
  svg.addEventListener('pointermove', event => {
    const rect = svg.getBoundingClientRect();
    const px = (event.clientX - rect.left) * width / rect.width;
    const py = (event.clientY - rect.top) * height / rect.height;
    if (px < margin.left || px > right || py < margin.top || py > bottom) return hide();
    const candidates = valid.filter(inView);
    const closest = candidates.reduce((a, b) => Math.abs(x(b.time) - px) < Math.abs(x(a.time) - px) ? b : a);
    const pollIndex = visiblePolls.findIndex(row => Math.hypot(x(row.time) - px, y(+row.talarico_2p) - py) < dotR(row) + 4);
    const poll = pollIndex >= 0 ? visiblePolls[pollIndex] : null;
    circles.forEach((c, i) => c.classList.toggle('active', i === pollIndex));
    marksGroup?.classList.toggle('dimmed', pollIndex >= 0);
    const anchor = poll || closest;
    const inWindow = !shift && finite(closest[fm]);
    const cx = x(anchor.time);
    const cy = poll ? y(+poll.talarico_2p) : inWindow && show.fc ? y(+closest[fm]) : y(+closest[current]);
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility','visible');
    focus.setAttribute('cx', cx); focus.setAttribute('cy', cy); focus.setAttribute('visibility','visible');
    const avgText = `${shift ? 'Shift' : 'Poll average'}: ${format(+closest[current], shift)} <span class="muted">(95%: ${format(+closest[current] - 1.96 * +closest.se, shift)}–${format(+closest[current] + 1.96 * +closest.se, shift)})</span>`;
    tooltip.innerHTML = poll
      ? pollTooltip(poll)
      : `<strong>${dateLabel(closest.time)}</strong><br>${avgText}${inWindow ? `<br>${has.traj ? `Projected path: ${pct(closest[fm])} <span class="muted">— an assumed glide from the current poll average to the Election Day forecast; only the endpoint is modeled.</span>` : `Forecast: ${pct(closest[fm])}`} <span class="muted">(95%: ${pct(closest[flo])}–${pct(closest[fhi])})</span>${finite(closest.fund_weight) ? `<br>Weight: polls ${pct(1 - +closest.fund_weight, 0)} / fundamentals ${pct(closest.fund_weight, 0)}` : ''}${finite(closest.fade_shift_2p) ? `<br>Brown fade shift: ${signed(closest.fade_shift_2p)}` : ''}` : ''}${show.fund && finite(fundMean) ? `<br>Fundamentals (adopted): ${pct(fundMean)}` : ''}${!shift && has.approval && finite(closest.tx_net_approval) ? `<br>Texas net approval: ${+closest.tx_net_approval > 0 ? '+' : +closest.tx_net_approval < 0 ? '−' : ''}${Math.abs(+closest.tx_net_approval).toFixed(1)}${closest.approval_held === 'TRUE' ? ' <span class="muted">(last Civiqs reading held)</span>' : ''}` : ''}${show.fsens && finite(closest.fund_appr_mean) ? `<br>Fundamentals moved by Texas approval: ${pct(closest.fund_appr_mean)} <span class="muted">(sensitivity)</span>` : ''}`;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    tooltip.style.left = `${cx + 10 + tw > width ? Math.max(4, cx - tw - 10) : cx + 10}px`;
    tooltip.style.top = `${Math.max(4, Math.min(height - th - 4, cy - th / 2))}px`;
  });
  svg.addEventListener('pointerleave', hide);
}
