import { scaleLinear } from 'd3-scale';
import { csv, pct, count, escapeHTML } from './data.js';
import { partyColor } from './map.js';
import { contours } from './contours.js';

const root = document.querySelector('#scatter-chart');
const select = document.querySelector('#scatter-scenario');
const caption = document.querySelector('#scatter-caption');
const note = document.querySelector('#scatter-note');
const chance = document.querySelector('#scatter-chance');
const views = [['votes', 'Votes'], ['turnout_share', 'Turnout vs margin']];
const levels = [.5, .8, .95];
const scenarioLabels = {
  headline:'Headline',
  fund50:'Fundamentals 50% of precision (with primary-enthusiasm shift)', fund60:'Fundamentals 60% of precision (with primary-enthusiasm shift)', fund70:'Fundamentals 70% of precision (with primary-enthusiasm shift)',
  ne50:'Fundamentals 50% of precision (without enthusiasm shift)', ne60:'Fundamentals 60% of precision (without enthusiasm shift)', ne70:'Fundamentals 70% of precision (without enthusiasm shift)',
  noenth:'No enthusiasm shift, current weights', appr:'Fundamentals moved by Texas approval',
};
const scenarioOrder = ['headline', 'fund50', 'fund60', 'fund70', 'ne50', 'ne60', 'ne70', 'noenth', 'appr'];
const displayTheme = () => document.documentElement.dataset.layout === 'dark' ? 'dark' : 'light';
let points = new Map(), density = new Map(), axes = new Map();
let published = new Map();
let scenario = 'headline', view = 'votes', ready = false;
const contourCache = new Map();

const cellsFor = (scenarioId, viewId) => density.get(`${scenarioId}|${viewId}`) || [];
function contoursFor(scenarioId, viewId) {
  const key = `${scenarioId}|${viewId}`;
  if (!contourCache.has(key)) contourCache.set(key, contours(cellsFor(scenarioId, viewId)));
  return contourCache.get(key);
}

const coords = (row, viewId) => viewId === 'votes' ? [row.p / 1e6, row.t / 1e6] : [row.turnout, row.share];
const axisLabel = viewId => viewId === 'votes' ? ['Paxton votes (millions)', 'Talarico votes (millions)'] : ['Turnout', 'Talarico two-party share'];
const tickText = (viewId, axis) => viewId === 'votes' ? v => v.toFixed(1) : v => `${Math.round(v * 100)}%`;
const fixed = (v, digits = 1) => Number.isFinite(+v) ? (+v).toFixed(digits) : 'n/a';

function tooltipHTML(row) {
  return `<strong>${escapeHTML(scenarioLabels[scenario] || scenario)}</strong><br>Talarico ${count(row.t)} votes<br>Paxton ${count(row.p)} votes<br>Brown ${count(row.b)} votes<br>Ballots ${count(row.ballots)}<br>Turnout ${pct(row.turnout)}<br>Two-party share ${pct(row.share)}<br>Brown share ${pct(row.bshare)}<br>Winner: ${row.win ? 'Talarico' : 'Paxton'}`;
}

function draw() {
  if (!ready || !root.clientWidth || !root.clientHeight) return;
  const width = Math.max(220, root.clientWidth), height = Math.max(180, root.clientHeight);
  const narrow = width < 360;
  const margin = { top:8, right:12, bottom:narrow ? 34 : 38, left:narrow ? 40 : 46 };
  const right = width - margin.right, bottom = height - margin.bottom;
  const limit = axis => { const row = axes.get(`${view}|${axis}`); return [row.lo, row.hi]; };
  const x = scaleLinear().domain(limit('x')).range([margin.left, right]);
  const y = scaleLinear().domain(limit('y')).range([bottom, margin.top]);
  const [xTitle, yTitle] = axisLabel(view), tick = tickText(view);
  const blue = partyColor('D', displayTheme()), red = partyColor('R', displayTheme());
  const rows = points.get(scenario) || [];
  const panel = root.closest('.fp-scatter');
  panel.style.setProperty('--sc-blue', blue); panel.style.setProperty('--sc-red', red);
  const grid = x.ticks(narrow ? 4 : 6).map(v => `<line class="sc-grid" x1="${x(v)}" x2="${x(v)}" y1="${margin.top}" y2="${bottom}"/><text class="sc-axis" x="${x(v)}" y="${bottom + 13}" text-anchor="middle">${tick(v)}</text>`).join('')
    + y.ticks(narrow ? 4 : 6).map(v => `<line class="sc-grid" x1="${margin.left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text class="sc-axis" x="${margin.left - 5}" y="${y(v) + 3}" text-anchor="end">${tick(v)}</text>`).join('');
  const dots = rows.map((row, i) => { const [px, py] = coords(row, view); return `<circle class="sc-dot" cx="${x(px).toFixed(1)}" cy="${y(py).toFixed(1)}" r="1.5" fill="${row.win ? blue : red}" data-i="${i}"/>`; }).join('');
  const sets = contoursFor(scenario, view);
  const lines = sets.map((segments, level) => `<path class="sc-contour c${level}" d="${segments.map(([a, b]) => `M${x(a[0]).toFixed(1)},${y(a[1]).toFixed(1)}L${x(b[0]).toFixed(1)},${y(b[1]).toFixed(1)}`).join('')}"/>`).join('');
  // The tie line sits above the points and contours. Votes: y = x over the shared range; turnout view: y = 0.5.
  let tie, tieLabel;
  if (view === 'votes') {
    const lo = Math.max(x.domain()[0], y.domain()[0]), hi = Math.min(x.domain()[1], y.domain()[1]);
    tie = `<line class="sc-tie" x1="${x(lo)}" y1="${y(lo)}" x2="${x(hi)}" y2="${y(hi)}"/>`;
    tieLabel = { x:x(hi) - 4, y:y(hi) + 12, anchor:'end' };
  } else {
    tie = `<line class="sc-tie" x1="${margin.left}" x2="${right}" y1="${y(.5)}" y2="${y(.5)}"/>`;
    tieLabel = { x:right - 4, y:y(.5) - 4, anchor:'end' };
  }
  // Contour labels: first clear candidate among the extreme points of each contour, away from the tie label and from each other.
  const taken = [{ l:tieLabel.x - 22, t:tieLabel.y - 11, r:tieLabel.x + 2, b:tieLabel.y + 3 }];
  const labels = sets.map((segments, level) => {
    if (!segments.length) return '';
    const pts = segments.flat().map(([px, py]) => [x(px), y(py)]);
    const pick = [pts.reduce((a, p) => p[1] < a[1] ? p : a), pts.reduce((a, p) => p[0] > a[0] ? p : a), pts.reduce((a, p) => p[1] > a[1] ? p : a), pts.reduce((a, p) => p[0] < a[0] ? p : a)];
    const text = `${Math.round(levels[level] * 100)}%`, w = text.length * 6 + 4;
    const spots = pick.flatMap(([px, py]) => [{ cx:px, cy:py - 4 }, { cx:px + w / 2 + 4, cy:py + 3 }, { cx:px - w / 2 - 4, cy:py + 3 }, { cx:px, cy:py + 12 }]);
    const fits = s => s.cx - w / 2 >= margin.left && s.cx + w / 2 <= right && s.cy - 10 >= margin.top && s.cy + 3 <= bottom;
    const box = s => ({ l:s.cx - w / 2, r:s.cx + w / 2, t:s.cy - 10, b:s.cy + 3 });
    const clear = s => taken.every(o => { const q = box(s); return q.r < o.l || q.l > o.r || q.b < o.t || q.t > o.b; });
    const spot = spots.find(s => fits(s) && clear(s));
    if (!spot) return '';
    taken.push(box(spot));
    return `<text class="sc-label c${level}" x="${spot.cx}" y="${spot.cy}" text-anchor="middle">${text}</text>`;
  }).join('');
  const clipId = 'sc-clip';
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Simulated outcomes for ${escapeHTML(scenarioLabels[scenario] || scenario)}, ${view === 'votes' ? 'Talarico votes against Paxton votes' : 'Talarico two-party share against turnout'}">
    <defs><clipPath id="${clipId}"><rect x="${margin.left}" y="${margin.top}" width="${right - margin.left}" height="${bottom - margin.top}"/></clipPath></defs>
    ${grid}<rect class="sc-frame" x="${margin.left}" y="${margin.top}" width="${right - margin.left}" height="${bottom - margin.top}"/>
    <g clip-path="url(#${clipId})"><g class="sc-points">${dots}</g>${lines}${tie}</g>${labels}
    <text class="sc-tie-label" x="${tieLabel.x}" y="${tieLabel.y}" text-anchor="${tieLabel.anchor}">tie</text>
    <text class="sc-title" x="${(margin.left + right) / 2}" y="${height - 4}" text-anchor="middle">${escapeHTML(xTitle)}</text>
    <text class="sc-title" transform="translate(11 ${(margin.top + bottom) / 2}) rotate(-90)" text-anchor="middle">${escapeHTML(yTitle)}</text>
    <circle class="sc-hover" r="4.5" visibility="hidden"/>
  </svg><div class="chart-tooltip" hidden></div>`;
  const svg = root.querySelector('svg'), tooltip = root.querySelector('.chart-tooltip'), ring = root.querySelector('.sc-hover');
  const px = rows.map(row => { const [a, b] = coords(row, view); return [x(a), y(b)]; });
  svg.addEventListener('pointermove', event => {
    const rect = svg.getBoundingClientRect();
    const mx = (event.clientX - rect.left) * width / rect.width, my = (event.clientY - rect.top) * height / rect.height;
    let best = -1, bestDistance = 64;
    for (let i = 0; i < px.length; i++) { const d = (px[i][0] - mx) ** 2 + (px[i][1] - my) ** 2; if (d < bestDistance) { bestDistance = d; best = i; } }
    if (best < 0) { tooltip.hidden = true; ring.setAttribute('visibility', 'hidden'); return; }
    ring.setAttribute('cx', px[best][0]); ring.setAttribute('cy', px[best][1]); ring.setAttribute('visibility', 'visible');
    ring.setAttribute('stroke', rows[best].win ? blue : red);
    tooltip.innerHTML = tooltipHTML(rows[best]);
    tooltip.hidden = false;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    tooltip.style.left = `${px[best][0] + 10 + tw > width ? Math.max(4, px[best][0] - tw - 10) : px[best][0] + 10}px`;
    tooltip.style.top = `${Math.max(4, Math.min(height - th - 4, px[best][1] - th / 2))}px`;
  });
  svg.addEventListener('pointerleave', () => { tooltip.hidden = true; ring.setAttribute('visibility', 'hidden'); });
}

function refresh() {
  for (const button of document.querySelectorAll('[data-scatter-view]')) button.setAttribute('aria-pressed', String(button.dataset.scatterView === view));
  note.hidden = view !== 'turnout_share';
  const stated = published.get(scenario);
  // The line keeps its height when empty so the plot does not move between scenarios.
  chance.textContent = stated == null ? '' : `Published chance Talarico wins: ${pct(stated, 0)}.`;
  draw();
}

export async function initScatter(headline, sensitivities) {
  try {
    const [pointRows, densityRows, axisRows] = await Promise.all(['sim_scatter_points.csv', 'sim_scatter_density.csv', 'sim_scatter_axes.csv'].map(csv));
    const need = (rows, columns) => columns.every(column => rows.columns.includes(column));
    if (!need(pointRows, ['scenario','draw','talarico_votes','paxton_votes','brown_votes','ballots','turnout','share2p','brown_share','talarico_wins']) || !need(densityRows, ['scenario','view','x','y','mass']) || !need(axisRows, ['view','axis','lo','hi'])) throw new Error('The simulation files are missing expected columns.');
    for (const row of pointRows) {
      if (!points.has(row.scenario)) points.set(row.scenario, []);
      points.get(row.scenario).push({ id:row.draw, t:+row.talarico_votes, p:+row.paxton_votes, b:+row.brown_votes, ballots:+row.ballots, turnout:+row.turnout, share:+row.share2p, bshare:+row.brown_share, win:String(row.talarico_wins).toUpperCase() === 'TRUE' });
    }
    for (const row of densityRows) {
      const key = `${row.scenario}|${row.view}`;
      if (!density.has(key)) density.set(key, []);
      density.get(key).push({ x:+row.x, y:+row.y, m:+row.mass });
    }
    for (const row of axisRows) axes.set(`${row.view}|${row.axis}`, { lo:+row.lo, hi:+row.hi });
  } catch (error) {
    root.innerHTML = `<p class="note">${escapeHTML(error.message)}</p>`;
    return;
  }
  // Win probabilities shown here are the ones the dashboard already loads: the combined headline and the Texas-approval scenario.
  const combined = headline.find(row => row.component === 'combined');
  if (combined && Number.isFinite(+combined.p_talarico_win)) published.set('headline', +combined.p_talarico_win);
  const approval = sensitivities?.find(row => row.scenario === 'fundamentals moved by Texas approval');
  if (approval && Number.isFinite(+approval.p_talarico_win)) published.set('appr', +approval.p_talarico_win);
  const ids = [...points.keys()].sort((a, b) => (scenarioOrder.indexOf(a) + 1 || 99) - (scenarioOrder.indexOf(b) + 1 || 99));
  scenario = ids.includes('headline') ? 'headline' : ids[0];
  select.replaceChildren(...ids.map(id => new Option(scenarioLabels[id] || id, id, false, id === scenario)));
  select.title = select.selectedOptions[0].text;
  caption.textContent = `${count(points.get(scenario).length)} simulations shown per scenario; contours from all simulations.`;
  ready = true;
  refresh();
}

select.addEventListener('change', () => { scenario = select.value; select.title = select.selectedOptions[0].text; refresh(); });
for (const button of document.querySelectorAll('[data-scatter-view]')) button.addEventListener('click', () => { view = button.dataset.scatterView; refresh(); });
new ResizeObserver(() => draw()).observe(root);
window.addEventListener('display-change', () => draw());
window.addEventListener('panel-layout', () => draw());
