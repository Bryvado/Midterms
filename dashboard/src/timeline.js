import { races, raceOf, state, setState, ensureStore, shareOf, indexOf, statewide } from './compare.js';
import { pct, escapeHTML } from './data.js';
import { countyNames } from './labels.js';

const shapes = {
  pres:(x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}"/>`,
  sen:(x, y, r) => `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}"/>`,
  gov:(x, y, r) => `<path d="M${x},${y - r * 1.2}L${x + r * 1.15},${y + r * .9}L${x - r * 1.15},${y + r * .9}Z"/>`,
};
let cleanup = null;

// D two-party share in every race, then the 2026 projection with its 90% bar. Missing races are gaps. Two clicks set the active pair.
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
  const series = {
    place:races.map(race => shareOf(store, race.key)[i]),
    county:countyStore && ci !== undefined && level !== 'county' ? races.map(race => shareOf(countyStore, race.key)[ci]) : null,
    state:races.map(race => statewide(store, race.key).share),
  };
  const last = races.length - 1, lo = Math.min(...Object.values(series).filter(Boolean).flat().filter(Number.isFinite), store.q05[i] || 1), hi = Math.max(...Object.values(series).filter(Boolean).flat().filter(Number.isFinite), store.q95[i] || 0);
  const step = hi - lo > .5 ? .2 : hi - lo > .2 ? .1 : .05;
  const yLo = Math.max(0, Math.floor((lo - .01) / step) * step), yHi = Math.min(1, Math.ceil((hi + .01) / step) * step);
  const width = Math.max(240, host.clientWidth || 320), height = 190, margin = { left:32, right:10, top:8, bottom:34 };
  const x = k => margin.left + k * (width - margin.left - margin.right) / last, y = v => height - margin.bottom - (v - yLo) / (yHi - yLo) * (height - margin.top - margin.bottom);
  const ticks = []; for (let v = yLo; v <= yHi + 1e-9; v += step) ticks.push(+v.toFixed(3));
  const path = values => values.map((v, k) => Number.isFinite(v) ? v : null).reduce((d, v, k, all) => v === null ? d : `${d}${k > 0 && all[k - 1] !== null ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`, '');
  const marks = (values, cls, radius) => values.map((v, k) => Number.isFinite(v) ? `<g class="tl-mark ${cls}" data-k="${k}">${shapes[races[k].office](+x(k).toFixed(1), +y(v).toFixed(1), radius)}</g>` : '').join('');
  const axis = ticks.map(v => `<line class="tl-grid${Math.abs(v - .5) < 1e-9 ? ' half' : ''}" x1="${margin.left}" x2="${width - margin.right}" y1="${y(v)}" y2="${y(v)}"/><text class="tl-axis" x="${margin.left - 4}" y="${y(v) + 3}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');
  const labels = races.map((race, k) => `<text class="tl-axis" x="${x(k)}" y="${height - 20}" text-anchor="middle">${race.forecast ? 'Fcst' : `'${String(race.year).slice(2)}`}</text><text class="tl-axis tl-office" x="${x(k)}" y="${height - 9}" text-anchor="middle">${race.forecast ? '' : { pres:'Pres', sen:'Sen', gov:'Gov' }[race.office]}</text>`).join('');
  const bar = Number.isFinite(store.q05[i]) && Number.isFinite(store.q95[i]) ? `<line class="tl-range" x1="${x(last)}" x2="${x(last)}" y1="${y(store.q05[i])}" y2="${y(store.q95[i])}"/><line class="tl-cap" x1="${x(last) - 4}" x2="${x(last) + 4}" y1="${y(store.q05[i])}" y2="${y(store.q05[i])}"/><line class="tl-cap" x1="${x(last) - 4}" x2="${x(last) + 4}" y1="${y(store.q95[i])}" y2="${y(store.q95[i])}"/>` : '';
  const hits = races.map((race, k) => Number.isFinite(series.place[k]) ? `<circle class="tl-hit" cx="${x(k)}" cy="${y(series.place[k])}" r="9" data-k="${k}" tabindex="0" role="button" aria-label="${escapeHTML(race.label)}: ${pct(series.place[k])}. Select to compare."/>` : '').join('');
  const countyName = ci !== undefined && countyStore ? names.get(store.county[i]) || 'County' : '';
  host.innerHTML = `<h3>Share over time</h3>
    <svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Democratic two-party share in each race">
      ${axis}${labels}
      <path class="tl-line tl-state" d="${path(series.state)}"/>${series.county ? `<path class="tl-line tl-county" d="${path(series.county)}"/>` : ''}
      <path class="tl-line tl-place" d="${path(series.place.slice(0, last))}"/>
      ${bar}${marks(series.state, 'tl-state', 2.6)}${series.county ? marks(series.county, 'tl-county', 2.8) : ''}${marks(series.place, 'tl-place', 3.8)}
      <g class="tl-rings"></g>${hits}
    </svg>
    <div class="tl-legend"><span><i class="tl-key place"></i>This place</span>${series.county ? `<span><i class="tl-key county"></i>${escapeHTML(countyName)} County</span>` : ''}<span><i class="tl-key state"></i>Statewide</span><span>Circle: president · Square: Senate · Triangle: governor</span></div>
    <p class="note tl-hint"></p>`;
  const svg = host.querySelector('svg'), rings = svg.querySelector('.tl-rings'), hint = host.querySelector('.tl-hint');
  let first = null;
  const drawRings = () => {
    const keyIndex = key => races.findIndex(race => race.key === key);
    const active = [keyIndex(state.from), keyIndex(state.to)];
    rings.innerHTML = [...active.map(k => ({ k, cls:'active' })), ...(first !== null ? [{ k:first, cls:'pending' }] : [])].filter(({ k }) => Number.isFinite(series.place[k])).map(({ k, cls }) => `<circle class="tl-ring ${cls}" cx="${x(k)}" cy="${y(series.place[k])}" r="7"/>`).join('');
    hint.textContent = first !== null ? `${races[first].label} selected. Select a second point to compare.` : `Select two points to compare them. Active pair: ${raceOf(state.from).label} to ${raceOf(state.to).label}.`;
  };
  const pick = k => {
    if (first === null) { first = k; drawRings(); return; }
    if (first === k) { first = null; drawRings(); return; }
    const [a, b] = first < k ? [first, k] : [k, first];
    first = null;
    setState({ from:races[a].key, to:races[b].key });
  };
  svg.addEventListener('click', event => { const hit = event.target.closest('.tl-hit'); if (hit) pick(+hit.dataset.k); });
  svg.addEventListener('keydown', event => { const hit = event.target.closest('.tl-hit'); if (hit && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); pick(+hit.dataset.k); } });
  const onChange = () => { if (host.isConnected) drawRings(); };
  window.addEventListener('compare-change', onChange);
  cleanup = () => window.removeEventListener('compare-change', onChange);
  drawRings();
}
