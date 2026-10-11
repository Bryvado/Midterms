import { races, raceOf, state, setState, ensureStore, shareOf, indexOf, statewide } from './compare.js';
import { pct, escapeHTML } from './data.js';
import { countyNames } from './labels.js';

const offices = [['sen','Senate'], ['pres','President'], ['gov','Governor']];
let office = 'sen';
const off = new Set();
let cleanup = null;

// One office on a calendar axis (D two-party share, then the 2026 projection with its 90% bar) plus a composite: the mean of that place's races in each year. Missing races are gaps. Two clicks set the active pair.
export async function renderTimeline(host, level, regionId) {
  cleanup?.(); cleanup = null;
  if (!host) return;
  host.innerHTML = '<h3>Share over time</h3><p class="note">Loading the timeline…</p>';
  let store, countyStore = null, names;
  try {
    store = await ensureStore(level);
    names = await countyNames();
    if (level === 'precinct' || level === 'cousub') countyStore = await ensureStore('county');
  } catch (error) { host.innerHTML = `<h3>Share over time</h3><p class="note">${escapeHTML(error.message)}</p>`; return; }
  if (!host.isConnected) return;
  const i = indexOf(store, String(regionId));
  if (i === undefined) { host.innerHTML = ''; return; }
  const ci = countyStore ? indexOf(countyStore, store.county[i]) : undefined;
  const own = races.filter(race => race.office === office || (race.forecast && office === 'sen'));
  const at = (st, idx, race) => shareOf(st, race.key)[idx];
  const years = [...new Set(races.map(race => race.year))];
  const composite = (st, idx) => years.map(year => { const v = races.filter(race => race.year === year).map(race => at(st, idx, race)).filter(Number.isFinite); return v.length ? v.reduce((sum, u) => sum + u, 0) / v.length : NaN; });
  const series = {
    place:own.map(race => at(store, i, race)),
    county:countyStore && ci !== undefined && level !== 'county' ? own.map(race => at(countyStore, ci, race)) : null,
    state:own.map(race => statewide(store, race.key).share),
    mix:composite(store, i),
  };
  const forecastK = own.findIndex(race => race.forecast), last = own.length - 1;
  const all = [...series.place, ...series.state, ...(series.county || []), ...series.mix].filter(Number.isFinite);
  const lo = Math.min(...all, store.q05[i] || 1), hi = Math.max(...all, store.q95[i] || 0);
  const step = hi - lo > .5 ? .2 : hi - lo > .2 ? .1 : .05;
  const yLo = Math.max(0, Math.floor((lo - .01) / step) * step), yHi = Math.min(1, Math.ceil((hi + .01) / step) * step);
  const width = Math.max(240, host.clientWidth || 320), height = 250, margin = { left:34, right:20, top:12, bottom:24 };
  const y0 = years[0] - .5, y1 = years[years.length - 1] + .5, yEnd = years[years.length - 1];
  const x = year => margin.left + (year - y0) * (width - margin.left - margin.right) / (y1 - y0), y = v => height - margin.bottom - (v - yLo) / (yHi - yLo) * (height - margin.top - margin.bottom);
  const ticks = []; for (let v = yLo; v <= yHi + 1e-9; v += step) ticks.push(+v.toFixed(3));
  const xs = list => list.map(item => x(item.year));
  const line = (values, xv) => values.reduce((d, v, k) => Number.isFinite(v) ? `${d}${d && Number.isFinite(values[k - 1]) ? 'L' : 'M'}${xv[k].toFixed(1)},${y(v).toFixed(1)}` : d, '');
  const ownX = xs(own), yearX = years.map(x);
  const marks = (values, cls, radius) => values.map((v, k) => Number.isFinite(v) ? `<circle class="tl-mark ${cls}" cx="${ownX[k].toFixed(1)}" cy="${y(v).toFixed(1)}" r="${radius}"/>` : '').join('');
  const axis = ticks.map(v => `<line class="tl-grid${Math.abs(v - .5) < 1e-9 ? ' half' : ''}" x1="${margin.left}" x2="${width - margin.right}" y1="${y(v)}" y2="${y(v)}"/><text class="tl-axis" x="${margin.left - 4}" y="${y(v) + 3}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');
  const labels = years.map(year => `<text class="tl-axis" x="${x(year)}" y="${height - 6}" text-anchor="middle">${year === yEnd ? 'Fcst' : year}</text>`).join('');
  const bar = forecastK >= 0 && Number.isFinite(store.q05[i]) && Number.isFinite(store.q95[i]) ? `<line class="tl-range" x1="${x(yEnd)}" x2="${x(yEnd)}" y1="${y(store.q05[i])}" y2="${y(store.q95[i])}"/><line class="tl-cap" x1="${x(yEnd) - 4}" x2="${x(yEnd) + 4}" y1="${y(store.q05[i])}" y2="${y(store.q05[i])}"/><line class="tl-cap" x1="${x(yEnd) - 4}" x2="${x(yEnd) + 4}" y1="${y(store.q95[i])}" y2="${y(store.q95[i])}"/>` : '';
  const hits = own.map((race, k) => Number.isFinite(series.place[k]) ? `<circle class="tl-hit" cx="${ownX[k]}" cy="${y(series.place[k])}" r="9" data-k="${k}" tabindex="0" role="button" aria-label="${escapeHTML(race.label)}: ${pct(series.place[k])}. Select to compare."/>` : '').join('');
  const smooth = (x1, v1, x2, v2) => `M${x1.toFixed(1)},${y(v1).toFixed(1)}C${((x1 + x2) / 2).toFixed(1)},${y(v1).toFixed(1)} ${((x1 + x2) / 2).toFixed(1)},${y(v2).toFixed(1)} ${x2.toFixed(1)},${y(v2).toFixed(1)}`;
  // Dashed, smoothed tracks from the latest past result to the projection, with level tangents at both ends.
  const lastPast = series.place.findLastIndex((v, k) => k !== forecastK && Number.isFinite(v));
  const projected = forecastK >= 0 && lastPast >= 0 && Number.isFinite(series.place[forecastK]) ? `<path class="tl-line tl-place tl-projected" d="${smooth(ownX[lastPast], series.place[lastPast], ownX[forecastK], series.place[forecastK])}"/>` : '';
  const mixLast = series.mix.findLastIndex((v, k) => k < years.length - 1 && Number.isFinite(v));
  const mixProjected = mixLast >= 0 && Number.isFinite(series.mix[years.length - 1]) ? `<path class="tl-line tl-mix tl-projected" d="${smooth(yearX[mixLast], series.mix[mixLast], yearX[years.length - 1], series.mix[years.length - 1])}"/>` : '';
  const mixMarks = series.mix.map((v, k) => Number.isFinite(v) ? `<rect class="tl-mark tl-mix" x="${(yearX[k] - 2.6).toFixed(1)}" y="${(y(v) - 2.6).toFixed(1)}" width="5.2" height="5.2" transform="rotate(45 ${yearX[k].toFixed(1)} ${y(v).toFixed(1)})"/>` : '').join('');
  const officeLabel = offices.find(([key]) => key === office)[1];
  const countyName = ci !== undefined && countyStore ? names.get(store.county[i]) || 'County' : '';
  host.innerHTML = `<h3>Share over time</h3>
    <div class="tl-tabs" role="group" aria-label="Office shown">${offices.map(([key, label]) => `<button type="button" class="tl-tab" data-office="${key}" aria-pressed="${key === office}">${label}</button>`).join('')}</div>
    <svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Democratic two-party share, ${officeLabel} races and the yearly composite">
      ${axis}${labels}
      <g class="tl-s" data-s="state"><path class="tl-line tl-state" d="${line(series.state, ownX)}"/>${marks(series.state, 'tl-state', 2.4)}</g>
      ${series.county ? `<g class="tl-s" data-s="county"><path class="tl-line tl-county" d="${line(series.county, ownX)}"/>${marks(series.county, 'tl-county', 2.6)}</g>` : ''}
      <g class="tl-s" data-s="mix"><path class="tl-line tl-mix" d="${line(series.mix.slice(0, -1), yearX)}"/>${mixProjected}${mixMarks}</g>
      <g class="tl-s" data-s="place"><path class="tl-line tl-place" d="${line(series.place.map((v, k) => k === forecastK ? NaN : v), ownX)}"/>${projected}${bar}${marks(series.place, 'tl-place', 3.8)}</g>
      <g class="tl-rings"></g><g class="tl-hits">${hits}</g>
    </svg>
    <div class="tl-legend" role="group" aria-label="Lines shown">${[['place', `This place, ${officeLabel}`], ['mix', 'All statewide races that year, averaged'], ...(series.county ? [['county', `${escapeHTML(countyName)} County, ${officeLabel}`]] : []), ['state', `Statewide, ${officeLabel}`]].map(([key, text]) => `<button type="button" class="tl-toggle" data-s="${key}" aria-pressed="${!off.has(key)}"><i class="tl-key ${key}"></i>${text}</button>`).join('')}</div>
    <p class="note tl-hint"></p>`;
  const svg = host.querySelector('svg'), rings = svg.querySelector('.tl-rings'), hint = host.querySelector('.tl-hint');
  const applyLines = () => {
    for (const g of svg.querySelectorAll('.tl-s')) g.style.display = off.has(g.dataset.s) ? 'none' : '';
    svg.querySelector('.tl-hits').style.display = svg.querySelector('.tl-rings').style.display = off.has('place') ? 'none' : '';
    for (const button of host.querySelectorAll('.tl-toggle')) button.setAttribute('aria-pressed', String(!off.has(button.dataset.s)));
  };
  host.querySelector('.tl-legend').addEventListener('click', event => { const button = event.target.closest('.tl-toggle'); if (!button) return; const key = button.dataset.s; if (off.has(key)) off.delete(key); else off.add(key); applyLines(); });
  applyLines();
  let first = null;
  const drawRings = () => {
    const keyIndex = key => own.findIndex(race => race.key === key);
    const active = [keyIndex(state.from), keyIndex(state.to)].filter(k => k >= 0);
    rings.innerHTML = [...active.map(k => ({ k, cls:'active' })), ...(first !== null ? [{ k:first, cls:'pending' }] : [])].filter(({ k }) => Number.isFinite(series.place[k])).map(({ k, cls }) => `<circle class="tl-ring ${cls}" cx="${ownX[k]}" cy="${y(series.place[k])}" r="7"/>`).join('');
    hint.textContent = first !== null ? `${own[first].label} selected. Select a second point to compare.` : `Select two points to compare them. Active pair: ${raceOf(state.from).label} to ${raceOf(state.to).label}.`;
  };
  const pick = k => {
    if (first === null) { first = k; drawRings(); return; }
    if (first === k) { first = null; drawRings(); return; }
    const [a, b] = first < k ? [first, k] : [k, first];
    first = null;
    setState({ from:own[a].key, to:own[b].key });
  };
  host.querySelector('.tl-tabs').addEventListener('click', event => { const tab = event.target.closest('.tl-tab'); if (tab && tab.dataset.office !== office) { office = tab.dataset.office; renderTimeline(host, level, regionId); } });
  svg.addEventListener('click', event => { const hit = event.target.closest('.tl-hit'); if (hit) pick(+hit.dataset.k); });
  svg.addEventListener('keydown', event => { const hit = event.target.closest('.tl-hit'); if (hit && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); pick(+hit.dataset.k); } });
  const onChange = () => { if (host.isConnected) drawRings(); };
  window.addEventListener('compare-change', onChange);
  cleanup = () => window.removeEventListener('compare-change', onChange);
  drawRings();
}
