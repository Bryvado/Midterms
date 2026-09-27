import { scaleLinear, scaleTime } from 'd3-scale';
import { line, area, curveMonotoneX } from 'd3-shape';
import { pct, signed, escapeHTML } from './data.js';

let track = [], polls = [], fundamentals = null, baselines = new Map(), current = 'mean';
const root = document.querySelector('#trend-chart');
const date = value => new Date(`${value}T00:00:00Z`);
const dateLabel = value => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC',month:'short',day:'numeric',year:'numeric' }).format(value);
const axisDate = value => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC',month:'short',year:'2-digit' }).format(value);
const format = (value, shift) => shift ? signed(value) : pct(value);

export function initChart(trackRows, pollRows, headline, shifts) {
  track = trackRows.map(row => ({ ...row, time:date(row.date) }));
  polls = pollRows.map(row => ({ ...row, time:date(row.end_date) }));
  fundamentals = headline.find(row => row.component === 'fundamentals');
  baselines = new Map(shifts.filter(row => row.component === 'combined').map(row => [row.baseline,row.label]));
  document.querySelector('#poll-summary').textContent = `Poll ledger · ${polls.length} polls`;
  renderChart('mean');
  new ResizeObserver(() => { if (root.clientWidth > 100) draw(); }).observe(root);
  window.addEventListener('resize', () => { if (root.clientWidth > 100) draw(); });
}

export function renderChart(measure) {
  current = measure.startsWith('shift_') ? measure : 'mean';
  const title = current === 'mean' ? 'Polling average' : `Shift vs ${baselines.get(current.slice(6)) || current.slice(6)}`;
  document.querySelector('#trend-title').textContent = title;
  if (root.clientWidth > 100 && track.length) draw();
}

function draw() {
  const width = Math.max(250,root.clientWidth), height = root.clientHeight || 310;
  const margin = { top:17,right:12,bottom:28,left:42 };
  const right = width-margin.right, bottom = height-margin.bottom;
  const shift = current !== 'mean';
  const valid = track.filter(row => Number.isFinite(+row[current]));
  if (!valid.length) { root.textContent = 'No trend available for this measure.'; return; }
  const lastObserved = valid.findLastIndex(row => row.projected !== 'TRUE');
  const observed = valid.slice(0,lastObserved+1);
  const projected = valid.slice(Math.max(0,lastObserved));
  const x = scaleTime().domain([valid[0].time,valid.at(-1).time]).range([margin.left,right]);
  const edges = valid.flatMap(row => [+row[current]-1.96*+row.se,+row[current]+1.96*+row.se]);
  if (!shift) {
    edges.push(.5,...polls.map(row => +row.talarico_2p));
    if (fundamentals) edges.push(+fundamentals.mean-1.96*+fundamentals.sd,+fundamentals.mean+1.96*+fundamentals.sd);
  } else edges.push(0);
  const low = Math.min(...edges), high = Math.max(...edges), pad = Math.max(.008,(high-low)*.08);
  const y = scaleLinear().domain([low-pad,high+pad]).range([bottom,margin.top]);
  const avgLine = line().x(row => x(row.time)).y(row => y(+row[current])).curve(curveMonotoneX);
  const band = area().x(row => x(row.time)).y0(row => y(+row[current]-1.96*+row.se)).y1(row => y(+row[current]+1.96*+row.se)).curve(curveMonotoneX);
  const baseline = shift ? 0 : .5;
  const ticks = y.ticks(4).map(value => `<g><line class="chart-grid" x1="${margin.left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="chart-axis" x="${margin.left-8}" y="${y(value)+3}" text-anchor="end">${escapeHTML(shift ? `${value>=0?'+':''}${Math.round(value*100)}%` : `${Math.round(value*100)}%`)}</text></g>`).join('');
  const timeTicks = x.ticks(width < 350 ? 3 : 4).map(value => `<text class="chart-axis" x="${x(value)}" y="${height-6}" text-anchor="middle">${axisDate(value)}</text>`).join('');
  const prior = !shift && fundamentals ? `<rect class="chart-prior" x="${margin.left}" y="${y(+fundamentals.mean+1.96*+fundamentals.sd)}" width="${right-margin.left}" height="${y(+fundamentals.mean-1.96*+fundamentals.sd)-y(+fundamentals.mean+1.96*+fundamentals.sd)}"/>` : '';
  const dots = shift ? '' : polls.map((row,i) => `<circle class="chart-poll" data-poll="${i}" cx="${x(row.time)}" cy="${y(+row.talarico_2p)}" r="${Math.max(2.5,11*Math.sqrt(+row.weight))}"/>`).join('');
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(document.querySelector('#trend-title').textContent)} and polling observations">
    ${prior}${ticks}<line class="chart-reference" x1="${margin.left}" x2="${right}" y1="${y(baseline)}" y2="${y(baseline)}"/>
    <path class="chart-band" d="${band(observed) || ''}"/><path class="chart-band projected" d="${band(projected) || ''}"/>
    <path class="chart-line" d="${avgLine(observed) || ''}"/><path class="chart-line projected" d="${avgLine(projected) || ''}"/>
    ${dots}${timeTicks}<line class="chart-cursor" x1="0" x2="0" y1="${margin.top}" y2="${bottom}" visibility="hidden"/><circle class="chart-focus" r="4" visibility="hidden"/>
  </svg><div class="chart-tooltip" hidden></div>`;
  const svg = root.querySelector('svg'), tooltip = root.querySelector('.chart-tooltip');
  const cursor = root.querySelector('.chart-cursor'), focus = root.querySelector('.chart-focus');
  svg.addEventListener('pointermove', event => {
    const rect = svg.getBoundingClientRect();
    const px = (event.clientX-rect.left)*width/rect.width;
    const py = (event.clientY-rect.top)*height/rect.height;
    if (px < margin.left || px > right || py < margin.top || py > bottom) { tooltip.hidden=true;cursor.setAttribute('visibility','hidden');focus.setAttribute('visibility','hidden');return; }
    const closest = valid.reduce((a,b) => Math.abs(x(b.time)-px) < Math.abs(x(a.time)-px) ? b : a);
    const poll = !shift && polls.find(row => Math.hypot(x(row.time)-px,y(+row.talarico_2p)-py) < 9);
    const anchor = poll || closest;
    const cx = x(anchor.time), cy = poll ? y(+poll.talarico_2p) : y(+closest[current]);
    cursor.setAttribute('x1',cx); cursor.setAttribute('x2',cx); cursor.setAttribute('visibility','visible');
    focus.setAttribute('cx',cx); focus.setAttribute('cy',cy); focus.setAttribute('visibility','visible');
    tooltip.innerHTML = poll ? `<strong>${escapeHTML(poll.pollster)}</strong><br>${dateLabel(poll.time)} · n=${escapeHTML(poll.n)}<br>Talarico two-party ${pct(poll.talarico_2p)}<br>Relative weight ${pct(poll.weight)}`
      : `<strong>${dateLabel(closest.time)}</strong><br>${shift ? 'Shift' : closest.projected === 'TRUE' ? 'Projected average' : 'Polling average'}: ${format(+closest[current],shift)}<br>95% band: ${format(+closest[current]-1.96*+closest.se,shift)} to ${format(+closest[current]+1.96*+closest.se,shift)}`;
    tooltip.style.left = `${Math.min(width-178,Math.max(7,cx+10))}px`;
    tooltip.style.top = `${Math.max(5,Math.min(height-86,cy-65))}px`;
    tooltip.hidden = false;
  });
  svg.addEventListener('pointerleave', () => { tooltip.hidden=true;cursor.setAttribute('visibility','hidden');focus.setAttribute('visibility','hidden'); });
}
