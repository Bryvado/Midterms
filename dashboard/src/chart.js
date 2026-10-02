import { scaleLinear, scaleTime } from 'd3-scale';
import { line, area, curveMonotoneX } from 'd3-shape';
import { pct, signed, escapeHTML } from './data.js';

let track = [], polls = [], combined = null, baselines = new Map(), current = 'mean';
const root = document.querySelector('#trend-chart');
const layerKeys = ['dots','avg','fc','fund'];
const layers = { dots:true, avg:true, fc:true, fund:false };
const date = value => new Date(`${value}T00:00:00Z`);
const dateLabel = value => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC',month:'short',day:'numeric',year:'numeric' }).format(value);
const axisDate = value => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC',month:'short',year:'2-digit' }).format(value);
const format = (value, shift) => shift ? signed(value) : pct(value);
const finite = v => v !== '' && v != null && v !== 'NA' && Number.isFinite(+v);

// Chart layer state lives in the URL as four 0/1 flags (dots, average, forecast, fundamentals).
const flags = new URLSearchParams(location.search).get('ct');
if (flags && /^[01]{4}$/.test(flags)) layerKeys.forEach((key, i) => { layers[key] = flags[i] === '1'; });

function writeFlags() {
  const url = new URL(location.href);
  const value = layerKeys.map(key => layers[key] ? '1' : '0').join('');
  if (value === '1110') url.searchParams.delete('ct'); else url.searchParams.set('ct', value);
  history.replaceState(null, '', url);
}

for (const input of document.querySelectorAll('[data-chart-layer]')) {
  input.checked = layers[input.dataset.chartLayer];
  input.addEventListener('change', () => {
    layers[input.dataset.chartLayer] = input.checked;
    writeFlags();
    if (track.length) draw();
  });
}

export function initChart(trackRows, pollRows, headline, shifts) {
  track = trackRows.map(row => ({ ...row, time:date(row.date) }));
  polls = pollRows.map(row => ({ ...row, time:date(row.end_date) }));
  combined = headline.find(row => row.component === 'combined');
  baselines = new Map(shifts.filter(row => row.component === 'combined').map(row => [row.baseline,row.label]));
  document.querySelector('#poll-summary').textContent = `Poll ledger · ${polls.length} polls`;
  renderChart('mean');
  new ResizeObserver(() => { if (root.clientWidth > 100) draw(); }).observe(root);
}

export function renderChart(measure) {
  current = measure.startsWith('shift_') ? measure : 'mean';
  const title = current === 'mean' ? 'Polling average and forecast' : `Shift vs ${baselines.get(current.slice(6)) || current.slice(6)}`;
  document.querySelector('#trend-title').textContent = title;
  for (const input of document.querySelectorAll('[data-chart-layer="fc"],[data-chart-layer="fund"],[data-chart-layer="dots"]')) input.disabled = current !== 'mean';
  document.querySelector('#chart-note').hidden = current !== 'mean';
  if (root.clientWidth > 100 && track.length) draw();
}

function draw() {
  const width = Math.max(220,root.clientWidth), height = Math.max(150, root.clientHeight || 260);
  const margin = { top:14,right:10,bottom:24,left:36 };
  const right = width-margin.right, bottom = height-margin.bottom;
  const shift = current !== 'mean';
  const show = { dots:layers.dots && !shift, avg:layers.avg, fc:layers.fc && !shift, fund:layers.fund && !shift };
  const valid = track.filter(row => finite(row[current]));
  if (!valid.length) { root.textContent = 'No trend available for this measure.'; return; }
  const lastObserved = valid.findLastIndex(row => row.projected !== 'TRUE');
  const observed = valid.slice(0,lastObserved+1);
  const projected = valid.slice(Math.max(0,lastObserved));
  const forecast = shift ? [] : track.filter(row => finite(row.forecast_mean));
  const fundMean = track.find(row => finite(row.fund_mean))?.fund_mean;
  const x = scaleTime().domain([valid[0].time,valid.at(-1).time]).range([margin.left,right]);
  const edges = [shift ? 0 : .5];
  if (show.avg) edges.push(...valid.flatMap(row => [+row[current]-1.96*+row.se,+row[current]+1.96*+row.se]));
  else edges.push(...valid.map(row => +row[current]));
  if (show.dots) edges.push(...polls.map(row => +row.talarico_2p));
  if (show.fc) edges.push(...forecast.flatMap(row => [+row.forecast_lo95,+row.forecast_hi95]));
  if (show.fund && finite(fundMean)) edges.push(+fundMean);
  const low = Math.min(...edges), high = Math.max(...edges), pad = Math.max(.006,(high-low)*.08);
  const y = scaleLinear().domain([low-pad,high+pad]).range([bottom,margin.top]);
  const avgLine = line().x(row => x(row.time)).y(row => y(+row[current])).curve(curveMonotoneX);
  const band = area().x(row => x(row.time)).y0(row => y(+row[current]-1.96*+row.se)).y1(row => y(+row[current]+1.96*+row.se)).curve(curveMonotoneX);
  const fcLine = line().x(row => x(row.time)).y(row => y(+row.forecast_mean)).curve(curveMonotoneX);
  const fcBand = area().x(row => x(row.time)).y0(row => y(+row.forecast_lo95)).y1(row => y(+row.forecast_hi95)).curve(curveMonotoneX);
  const reference = shift ? 0 : .5;
  const ticks = y.ticks(4).map(value => `<g><line class="chart-grid" x1="${margin.left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-axis" x="${margin.left-6}" y="${y(value)+3}" text-anchor="end">${escapeHTML(shift ? `${value>=0?'+':''}${Math.round(value*100)}%` : `${Math.round(value*100)}%`)}</text></g>`).join('');
  const timeTicks = x.ticks(width < 330 ? 3 : 4).map(value => `<text class="chart-axis" x="${x(value)}" y="${height-6}" text-anchor="middle">${axisDate(value)}</text>`).join('');
  const windowStart = forecast.length ? x(forecast[0].time) : null;
  const shade = show.fc && windowStart != null ? `<rect class="chart-window" x="${windowStart}" y="${margin.top}" width="${right-windowStart}" height="${bottom-margin.top}"/><text class="chart-axis chart-window-label" x="${right-3}" y="${bottom-4}" text-anchor="end">Projection</text>` : '';
  const avg = show.avg ? `<path class="chart-band" d="${band(observed) || ''}"/><path class="chart-band projected" d="${band(projected) || ''}"/>
    <path class="chart-line" d="${avgLine(observed) || ''}"/><path class="chart-line projected" d="${avgLine(projected) || ''}"/>` : '';
  let fc = '';
  if (show.fc && forecast.length) {
    const end = forecast.at(-1);
    const ex = x(end.time), ey = combined ? y(+combined.mean) : y(+end.forecast_mean);
    const label = combined ? `Forecast ${pct(combined.mean)} · ${pct(combined.p_talarico_win,0)} win prob` : '';
    fc = `<path class="chart-fc-band" d="${fcBand(forecast) || ''}"/><path class="chart-fc-line" d="${fcLine(forecast) || ''}"/>
      <circle class="chart-fc-marker" cx="${ex}" cy="${ey}" r="4.5"/>
      <text class="chart-fc-label" x="${ex-2}" y="${Math.max(margin.top + 9, y(Math.max(...forecast.map(row => +row.forecast_hi95))) - 5)}" text-anchor="end">${escapeHTML(label)}</text>`;
  }
  const fund = show.fund && finite(fundMean) ? `<line class="chart-fund" x1="${margin.left}" x2="${right}" y1="${y(+fundMean)}" y2="${y(+fundMean)}"/><text class="chart-fund-label" x="${margin.left+4}" y="${y(+fundMean)-4}">Fundamentals ${pct(fundMean)}</text>` : '';
  const dots = show.dots ? polls.map((row,i) => `<circle class="chart-poll" data-poll="${i}" cx="${x(row.time)}" cy="${y(+row.talarico_2p)}" r="${Math.max(2.3,10*Math.sqrt(+row.weight))}"/>`).join('') : '';
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(document.querySelector('#trend-title').textContent)}">
    ${shade}${ticks}<line class="chart-reference" x1="${margin.left}" x2="${right}" y1="${y(reference)}" y2="${y(reference)}"/>
    ${fund}${avg}${fc}${dots}${timeTicks}<line class="chart-cursor" x1="0" x2="0" y1="${margin.top}" y2="${bottom}" visibility="hidden"/><circle class="chart-focus" r="4" visibility="hidden"/>
  </svg><div class="chart-tooltip" hidden></div>`;
  const svg = root.querySelector('svg'), tooltip = root.querySelector('.chart-tooltip');
  const cursor = root.querySelector('.chart-cursor'), focus = root.querySelector('.chart-focus');
  const hide = () => { tooltip.hidden=true;cursor.setAttribute('visibility','hidden');focus.setAttribute('visibility','hidden'); };
  svg.addEventListener('pointermove', event => {
    const rect = svg.getBoundingClientRect();
    const px = (event.clientX-rect.left)*width/rect.width;
    const py = (event.clientY-rect.top)*height/rect.height;
    if (px < margin.left || px > right || py < margin.top || py > bottom) return hide();
    const closest = valid.reduce((a,b) => Math.abs(x(b.time)-px) < Math.abs(x(a.time)-px) ? b : a);
    const poll = show.dots && polls.find(row => Math.hypot(x(row.time)-px,y(+row.talarico_2p)-py) < 8);
    const anchor = poll || closest;
    const inWindow = !shift && finite(closest.forecast_mean);
    const cx = x(anchor.time);
    const cy = poll ? y(+poll.talarico_2p) : inWindow && show.fc ? y(+closest.forecast_mean) : y(+closest[current]);
    cursor.setAttribute('x1',cx); cursor.setAttribute('x2',cx); cursor.setAttribute('visibility','visible');
    focus.setAttribute('cx',cx); focus.setAttribute('cy',cy); focus.setAttribute('visibility','visible');
    const avgText = `${shift ? 'Shift' : 'Poll average'}: ${format(+closest[current],shift)} <span class="muted">(95%: ${format(+closest[current]-1.96*+closest.se,shift)}–${format(+closest[current]+1.96*+closest.se,shift)})</span>`;
    tooltip.innerHTML = poll
      ? `<strong>${escapeHTML(poll.pollster)}</strong><br>${dateLabel(poll.time)} · n=${escapeHTML(poll.n)}<br>Talarico two-party ${pct(poll.talarico_2p)}<br>Relative weight ${pct(poll.weight)}`
      : `<strong>${dateLabel(closest.time)}</strong><br>${avgText}${inWindow ? `<br>Forecast: ${pct(closest.forecast_mean)} <span class="muted">(95%: ${pct(closest.forecast_lo95)}–${pct(closest.forecast_hi95)})</span><br>Weight: polls ${pct(1 - +closest.fund_weight,0)} / fundamentals ${pct(closest.fund_weight,0)}<br>Brown fade shift: ${signed(closest.fade_shift_2p)}` : ''}`;
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    tooltip.style.left = `${cx + 10 + tw > width ? Math.max(4, cx - tw - 10) : cx + 10}px`;
    tooltip.style.top = `${Math.max(4,Math.min(height-th-4,cy-th/2))}px`;
  });
  svg.addEventListener('pointerleave', hide);
}
