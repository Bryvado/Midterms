import { races as compareRaces, state, setState, ensureStore, indexOf } from './compare.js';
import { pct, count, signed, escapeHTML, csv } from './data.js';
import { countyNames } from './labels.js';

const historyFiles = { precinct:'history_precinct.csv', county:'history_county.csv', cd:'history_congressional_district.csv', cousub:'history_county_subdivision.csv', puma:'history_puma.csv' };
const offices = [['sen', 'Senate', 'us_senate'], ['pres', 'President', 'president'], ['gov', 'Governor', 'governor']];
const compareOffice = { us_senate:'sen', president:'pres', governor:'gov' };
let office = 'sen';
const off = new Set(['sa']);
let pair = null;
let cleanup = null;

const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
const named = v => v != null && v !== '' && v !== 'NA';
const rowMaps = new Map();
const loadRows = level => {
  if (!rowMaps.has(level)) rowMaps.set(level, csv(historyFiles[level]).then(rows => new Map(rows.map(row => [row.region_id, row]))).catch(error => { rowMaps.delete(level); throw error; }));
  return rowMaps.get(level);
};
let raceInfo;
const loadRaces = () => raceInfo ||= csv('history_races.csv').then(rows => {
  const keep = new Set(offices.map(item => item[2]));
  const list = rows.filter(row => keep.has(row.office)).map(row => ({
    col:row.col, year:+row.year, office:row.office, tab:compareOffice[row.office], estimated:String(row.source).startsWith('tlc_'), statewide:num(row.two_party),
    label:named(row.dem_name) ? row.label : `${row.year} ${row.office_label}`,
    cmp:compareRaces.find(race => !race.forecast && race.office === compareOffice[row.office] && race.year === +row.year)?.key || null,
  })).sort((a, b) => a.year - b.year);
  const average = new Map(rows.filter(row => row.office === 'statewide_average').map(row => [+row.year, { col:row.col, share:num(row.two_party) }]));
  return { list, average };
}).catch(error => { raceInfo = null; throw error; });

const shareIn = (row, col) => {
  if (!row) return NaN;
  const dem = num(row[`dem_${col}`]), rep = num(row[`rep_${col}`]);
  return Number.isFinite(dem) && Number.isFinite(rep) && dem + rep > 0 ? dem / (dem + rep) : NaN;
};

// Place share dem / (dem + rep) in every year the chosen office has, from the published history file, then the 2026 projection with its 90% bar.
// Races with no votes are gaps. Two clicks set the active pair; pairs among 2016 and later races also drive the map comparison.
export async function renderTimeline(host, level, regionId, options = {}) {
  cleanup?.(); cleanup = null;
  if (!host) return;
  const results = options.results;
  host.innerHTML = '<h3>Share over time</h3><p class="note">Loading the timeline…</p>';
  let store, rows, countyRows = null, names, meta;
  try {
    [store, rows, meta, names] = await Promise.all([ensureStore(level), loadRows(level), loadRaces(), countyNames()]);
    if (level === 'precinct' || level === 'cousub') countyRows = await loadRows('county');
  } catch (error) { host.innerHTML = `<h3>Share over time</h3><p class="note">${escapeHTML(error.message)}</p>`; return; }
  if (!host.isConnected) return;
  const i = indexOf(store, String(regionId));
  if (i === undefined) { host.innerHTML = ''; return; }
  const row = rows.get(String(regionId)), countyRow = countyRows ? countyRows.get(store.county[i]) : null;
  const forecast = { col:null, year:2026, label:'2026 forecast', tab:'sen', cmp:'f26', forecast:true };
  const everyone = [...meta.list, forecast];
  const own = [...meta.list.filter(race => race.tab === office), ...(office === 'sen' ? [forecast] : [])];
  const shareOf = (race, source = row) => race.forecast ? (source === row ? store.mean[i] : NaN) : shareIn(source, race.col);
  const years = [...new Set([...meta.average.keys(), 2026])].sort((a, b) => a - b);
  const yearEnd = years[years.length - 1];
  const series = {
    place:own.map(race => shareOf(race)),
    county:countyRow && level !== 'county' ? own.map(race => race.forecast ? NaN : shareIn(countyRow, race.col)) : null,
    state:own.map(race => race.forecast ? NaN : race.statewide),
    mix:years.map(year => year === yearEnd ? store.mean[i] : row ? num(row[meta.average.get(year)?.col]) : NaN),
    sa:years.map(year => year === yearEnd ? NaN : meta.average.get(year)?.share ?? NaN),
  };
  const forecastK = own.findIndex(race => race.forecast), last = own.length - 1;
  const all = [...series.place, ...series.state, ...(series.county || []), ...series.mix, ...series.sa].filter(Number.isFinite);
  const lo = Math.min(...all, store.q05[i] || 1), hi = Math.max(...all, store.q95[i] || 0);
  const step = hi - lo > .5 ? .2 : hi - lo > .2 ? .1 : .05;
  const yLo = Math.max(0, Math.floor((lo - .01) / step) * step), yHi = Math.min(1, Math.ceil((hi + .01) / step) * step);
  const width = Math.max(240, host.clientWidth || 320), height = 250, margin = { left:34, right:18, top:12, bottom:24 };
  const x0 = years[0] - 1, x1 = yearEnd + 1;
  const x = year => margin.left + (year - x0) * (width - margin.left - margin.right) / (x1 - x0), y = v => height - margin.bottom - (v - yLo) / (yHi - yLo) * (height - margin.top - margin.bottom);
  const ticks = []; for (let v = yLo; v <= yHi + 1e-9; v += step) ticks.push(+v.toFixed(3));
  const ownX = own.map(race => x(race.year)), yearX = years.map(x);
  const line = (values, xv) => values.reduce((d, v, k) => Number.isFinite(v) ? `${d}${d && Number.isFinite(values[k - 1]) ? 'L' : 'M'}${xv[k].toFixed(1)},${y(v).toFixed(1)}` : d, '');
  const marks = (values, cls, radius) => values.map((v, k) => Number.isFinite(v) ? `<circle class="tl-mark ${cls}${own[k].estimated ? ' tl-est' : ''}" cx="${ownX[k].toFixed(1)}" cy="${y(v).toFixed(1)}" r="${radius}"/>` : '').join('');
  const axis = ticks.map(v => `<line class="tl-grid${Math.abs(v - .5) < 1e-9 ? ' half' : ''}" x1="${margin.left}" x2="${width - margin.right}" y1="${y(v)}" y2="${y(v)}"/><text class="tl-axis" x="${margin.left - 4}" y="${y(v) + 3}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');
  const labels = years.map(year => `<text class="tl-axis" x="${x(year)}" y="${height - 6}" text-anchor="middle">${year === yearEnd ? 'Fcst' : `'${String(year).slice(2)}`}</text>`).join('');
  const bar = forecastK >= 0 && Number.isFinite(store.q05[i]) && Number.isFinite(store.q95[i]) ? `<line class="tl-range" x1="${x(yearEnd)}" x2="${x(yearEnd)}" y1="${y(store.q05[i])}" y2="${y(store.q95[i])}"/><line class="tl-cap" x1="${x(yearEnd) - 4}" x2="${x(yearEnd) + 4}" y1="${y(store.q05[i])}" y2="${y(store.q05[i])}"/><line class="tl-cap" x1="${x(yearEnd) - 4}" x2="${x(yearEnd) + 4}" y1="${y(store.q95[i])}" y2="${y(store.q95[i])}"/>` : '';
  const hits = own.map((race, k) => Number.isFinite(series.place[k]) ? `<circle class="tl-hit" cx="${ownX[k].toFixed(1)}" cy="${y(series.place[k]).toFixed(1)}" r="9" data-k="${k}" tabindex="0" role="button" aria-label="${escapeHTML(race.label)}: ${pct(series.place[k])}. Select to compare."/>` : '').join('');
  const smooth = (x1v, v1, x2v, v2) => `M${x1v.toFixed(1)},${y(v1).toFixed(1)}C${((x1v + x2v) / 2).toFixed(1)},${y(v1).toFixed(1)} ${((x1v + x2v) / 2).toFixed(1)},${y(v2).toFixed(1)} ${x2v.toFixed(1)},${y(v2).toFixed(1)}`;
  // Dashed, smoothed tracks from the latest past result to the projection, with level tangents at both ends.
  const lastPast = series.place.findLastIndex((v, k) => k !== forecastK && Number.isFinite(v));
  const projected = forecastK >= 0 && lastPast >= 0 && Number.isFinite(series.place[forecastK]) ? `<path class="tl-line tl-place tl-projected" d="${smooth(ownX[lastPast], series.place[lastPast], ownX[forecastK], series.place[forecastK])}"/>` : '';
  const pastYears = years.length - 1;
  const mixLast = series.mix.findLastIndex((v, k) => k < pastYears && Number.isFinite(v));
  const mixProjected = mixLast >= 0 && Number.isFinite(series.mix[pastYears]) ? `<path class="tl-line tl-mix tl-projected" d="${smooth(yearX[mixLast], series.mix[mixLast], yearX[pastYears], series.mix[pastYears])}"/>` : '';
  const mixMarks = series.mix.map((v, k) => Number.isFinite(v) ? `<rect class="tl-mark tl-mix" x="${(yearX[k] - 2.6).toFixed(1)}" y="${(y(v) - 2.6).toFixed(1)}" width="5.2" height="5.2" transform="rotate(45 ${yearX[k].toFixed(1)} ${y(v).toFixed(1)})"/>` : '').join('');
  const saMarks = series.sa.map((v, k) => Number.isFinite(v) ? `<rect class="tl-mark tl-sa" x="${(yearX[k] - 2).toFixed(1)}" y="${(y(v) - 2).toFixed(1)}" width="4" height="4" transform="rotate(45 ${yearX[k].toFixed(1)} ${y(v).toFixed(1)})"/>` : '').join('');
  const officeLabel = offices.find(item => item[0] === office)[1];
  const countyName = countyRow ? names.get(store.county[i]) || 'County' : '';
  const legend = [['place', `This place, ${officeLabel}`], ['mix', 'All statewide races that year, averaged'], ...(series.county ? [['county', `${escapeHTML(countyName)} County, ${officeLabel}`]] : []), ['state', `Statewide, ${officeLabel}`], ['sa', 'Statewide, all races averaged']];
  host.innerHTML = `<h3>Share over time</h3>
    <div class="tl-tabs" role="group" aria-label="Office shown">${offices.map(([key, label]) => `<button type="button" class="tl-tab" data-office="${key}" aria-pressed="${key === office}">${label}</button>`).join('')}</div>
    <svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Democratic two-party share, ${officeLabel} races and the yearly composite">
      ${axis}${labels}
      <g class="tl-s" data-s="sa"><path class="tl-line tl-sa" d="${line(series.sa, yearX)}"/>${saMarks}</g>
      <g class="tl-s" data-s="state"><path class="tl-line tl-state" d="${line(series.state, ownX)}"/>${marks(series.state, 'tl-state', 2.4)}</g>
      ${series.county ? `<g class="tl-s" data-s="county"><path class="tl-line tl-county" d="${line(series.county, ownX)}"/>${marks(series.county, 'tl-county', 2.6)}</g>` : ''}
      <g class="tl-s" data-s="mix"><path class="tl-line tl-mix" d="${line(series.mix.slice(0, -1), yearX)}"/>${mixProjected}${mixMarks}</g>
      <g class="tl-s" data-s="place"><path class="tl-line tl-place" d="${line(series.place.map((v, k) => k === forecastK ? NaN : v), ownX)}"/>${projected}${bar}${marks(series.place, 'tl-place', 3.8)}</g>
      <g class="tl-rings"></g><g class="tl-hits">${hits}</g>
    </svg>
    <div class="tl-legend" role="group" aria-label="Lines shown">${legend.map(([key, text]) => `<button type="button" class="tl-toggle" data-s="${key}" aria-pressed="${!off.has(key)}"><i class="tl-key ${key}"></i>${text}</button>`).join('')}</div>
    <p class="note tl-source">2002-2014 estimated on today's precinct lines from older precinct returns.</p>
    <p class="note tl-hint"></p>`;
  if (results) renderResults(results, meta.list.filter(race => race.tab === office), row, options.cell);

  const svg = host.querySelector('svg'), rings = svg.querySelector('.tl-rings'), hint = host.querySelector('.tl-hint');
  const applyLines = () => {
    for (const g of svg.querySelectorAll('.tl-s')) g.style.display = off.has(g.dataset.s) ? 'none' : '';
    svg.querySelector('.tl-hits').style.display = svg.querySelector('.tl-rings').style.display = off.has('place') ? 'none' : '';
    for (const button of host.querySelectorAll('.tl-toggle')) button.setAttribute('aria-pressed', String(!off.has(button.dataset.s)));
  };
  host.querySelector('.tl-legend').addEventListener('click', event => { const button = event.target.closest('.tl-toggle'); if (!button) return; const key = button.dataset.s; if (off.has(key)) off.delete(key); else off.add(key); applyLines(); });
  applyLines();

  let first = null;
  const byCompareKey = key => everyone.find(race => race.cmp === key);
  const idOf = race => race.forecast ? 'f26' : race.col;
  const raceById = id => id === 'f26' ? forecast : everyone.find(race => race.col === id);
  if (!pair) pair = { a:idOf(byCompareKey(state.from) || everyone[0]), b:idOf(byCompareKey(state.to) || forecast) };
  const drawRings = () => {
    const active = [pair.a, pair.b].map(id => own.findIndex(race => idOf(race) === id)).filter(k => k >= 0);
    rings.innerHTML = [...active.map(k => ({ k, cls:'active' })), ...(first !== null ? [{ k:first, cls:'pending' }] : [])].filter(({ k }) => Number.isFinite(series.place[k])).map(({ k, cls }) => `<circle class="tl-ring ${cls}" cx="${ownX[k].toFixed(1)}" cy="${y(series.place[k]).toFixed(1)}" r="7"/>`).join('');
    const A = raceById(pair.a), B = raceById(pair.b);
    if (first !== null) { hint.textContent = `${own[first].label} selected. Select a second point to compare.`; return; }
    if (!A || !B) { hint.textContent = 'Select two points to compare them.'; return; }
    const sa = shareOf(A), sb = shareOf(B);
    hint.textContent = Number.isFinite(sa) && Number.isFinite(sb) ? `${A.label}, ${pct(sa)}, to ${B.label}, ${pct(sb)}: ${signed(sb - sa)}. Select two points to compare others.` : `Select two points to compare them. Active pair: ${A.label} to ${B.label}.`;
  };
  const pick = k => {
    if (first === null) { first = k; drawRings(); return; }
    if (first === k) { first = null; drawRings(); return; }
    const [a, b] = own[first].year <= own[k].year ? [own[first], own[k]] : [own[k], own[first]];
    first = null;
    pair = { a:idOf(a), b:idOf(b) };
    if (a.cmp && b.cmp) setState({ from:a.cmp, to:b.cmp }); else drawRings();
  };
  svg.addEventListener('click', event => { const hit = event.target.closest('.tl-hit'); if (hit) pick(+hit.dataset.k); });
  svg.addEventListener('keydown', event => { const hit = event.target.closest('.tl-hit'); if (hit && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); pick(+hit.dataset.k); } });
  host.querySelector('.tl-tabs').addEventListener('click', event => { const tab = event.target.closest('.tl-tab'); if (tab && tab.dataset.office !== office) { office = tab.dataset.office; renderTimeline(host, level, regionId, options); } });
  const onChange = () => {
    if (!host.isConnected) return;
    const a = byCompareKey(state.from), b = byCompareKey(state.to);
    if (a && b) pair = { a:idOf(a), b:idOf(b) };
    drawRings();
  };
  window.addEventListener('compare-change', onChange);
  cleanup = () => window.removeEventListener('compare-change', onChange);
  drawRings();
}

// Every year the active office has, newest first. Races that also exist as map measures keep their shade buttons.
function renderResults(host, list, row, cell) {
  const rowsHtml = [...list].reverse().map(race => {
    const dem = row ? num(row[`dem_${race.col}`]) : NaN, rep = row ? num(row[`rep_${race.col}`]) : NaN, has = Number.isFinite(dem) && Number.isFinite(rep) && dem + rep > 0;
    const shaded = (key, label, kind, raw, text) => race.cmp && cell ? cell(key, label, kind, raw) : escapeHTML(text);
    return `<tr><td>${escapeHTML(race.label)}</td>${has ? `<td>${shaded(`dem_${race.cmp}`, `${race.label}: Democratic votes`, 'count', dem, count(dem))}</td><td>${shaded(`rep_${race.cmp}`, `${race.label}: Republican votes`, 'count', rep, count(rep))}</td><td>${shaded(`base_${race.cmp}`, `${race.label}: Democratic two-party share`, 'share', dem / (dem + rep), pct(dem / (dem + rep)))}</td>` : '<td>n/a</td><td>n/a</td><td>n/a</td>'}</tr>`;
  }).join('');
  host.innerHTML = `<h3>Past results, ${escapeHTML(offices.find(item => item[0] === office)[1])}</h3><div class="table-scroll"><table><thead><tr><th>Race</th><th>D votes</th><th>R votes</th><th>D two-party</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
}
