import { races as compareRaces, state, setState, ensureStore, indexOf } from './compare.js';
import { pct, count, signed, escapeHTML, csv } from './data.js';
import { countyNames, shortLabel } from './labels.js';

const historyFiles = { county:'history_county.csv', cd:'history_congressional_district.csv', puma:'history_puma.csv' };
const offices = [['sen', 'Senate', 'us_senate'], ['pres', 'President', 'president'], ['gov', 'Governor', 'governor']];
const compareOffice = { us_senate:'sen', president:'pres', governor:'gov' };
let office = 'sen';
let showOffice = true, showAvg = false, compareTexas = true;
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
    label:named(row.dem_name) ? row.label : `${row.year} ${row.office_label}`, officeLabel:row.office_label, candidate:named(row.dem_name) ? row.dem_name : '',
    cmp:compareRaces.find(race => !race.forecast && race.office === compareOffice[row.office] && race.year === +row.year)?.key || null,
  })).sort((a, b) => a.year - b.year);
  const average = new Map(rows.filter(row => row.office === 'statewide_average').map(row => [+row.year, { col:row.col, share:num(row.two_party) }]));
  const races = new Map();
  for (const row of rows) if (String(row.in_avg).toUpperCase() === 'TRUE') races.set(+row.year, (races.get(+row.year) || 0) + 1);
  return { list, average, races };
}).catch(error => { raceInfo = null; throw error; });

const shareIn = (row, col) => {
  if (!row) return NaN;
  const dem = num(row[`dem_${col}`]), rep = num(row[`rep_${col}`]);
  return Number.isFinite(dem) && Number.isFinite(rep) && dem + rep > 0 ? dem / (dem + rep) : NaN;
};

const dash = '—', minus = '−';
const gapText = g => `${g >= 0 ? '+' : minus}${Math.abs(100 * g).toFixed(1)}`;
const avgTip = 'Average Democratic two-party share across every contested statewide race that year (governor, senate, president, row offices and courts).';
const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const placeNameOf = (level, store, i, names) => {
  const label = store.labels[i];
  return shortLabel(level, label, names, { keepCounty:true });
};

// Two series types for this place, solid for the active office (dem / (dem + rep) in every year it has, then the 2026 projection with its 90% bar)
// and dotted for the all-race average, each with a grey Texas counterpart. Races with no votes are gaps. Two clicks set the compare pair;
// pairs among 2016 and later office races also drive the map comparison.
export async function renderTimeline(host, level, regionId, options = {}) {
  cleanup?.(); cleanup = null;
  if (!host) return;
  const results = options.results;
  host.innerHTML = '<h3>Share over time</h3><p class="note">Loading the timeline…</p>';
  let store, rows, names, meta;
  try {
    [store, rows, meta, names] = await Promise.all([ensureStore(level), loadRows(level), loadRaces(), countyNames()]);
  } catch (error) { host.innerHTML = `<h3>Share over time</h3><p class="note">${escapeHTML(error.message)}</p>`; return; }
  if (!host.isConnected) return;
  const i = indexOf(store, String(regionId));
  if (i === undefined) { host.innerHTML = ''; return; }
  const row = rows.get(String(regionId));
  const placeFull = placeNameOf(level, store, i, names), placeName = clip(placeFull, 24);
  const officeLabel = offices.find(item => item[0] === office)[1];
  const forecast = { col:null, year:2026, label:'2026 forecast', tab:'sen', cmp:'f26', forecast:true };
  const ownRaces = meta.list.filter(race => race.tab === office);
  const withForecast = office === 'sen' && showOffice;
  const own = [...ownRaces, ...(withForecast ? [forecast] : [])];
  const years = [...meta.average.keys()].sort((a, b) => a - b);
  const placeShare = race => race.forecast ? store.mean[i] : shareIn(row, race.col);
  const avgPlace = year => row ? num(row[meta.average.get(year)?.col]) : NaN;
  // Points: id, year, x-year, place value, Texas value and tooltip text pieces.
  const officePts = own.map(race => ({ id:race.forecast ? 'f26' : race.col, year:race.year, label:race.label, forecast:!!race.forecast, estimated:!!race.estimated, cmp:race.cmp, place:placeShare(race), texas:race.forecast ? NaN : race.statewide,
    head:race.forecast ? '2026 forecast' : `${race.year} ${race.officeLabel}${race.candidate ? ` (${race.candidate})` : ''}` }));
  const avgPts = years.map(year => ({ id:`avg${year}`, year, label:`All-race avg. ${year}`, forecast:false, estimated:year <= 2014, cmp:null, place:avgPlace(year), texas:meta.average.get(year)?.share ?? NaN,
    head:`${year} all-race avg. (${meta.races.get(year) ?? 0} races)` }));
  const showTexas = compareTexas;
  const compareSeries = showOffice ? 'office' : 'avg';
  const pts = compareSeries === 'office' ? officePts : avgPts;
  const nameOf = compareSeries === 'office' ? officeLabel : 'All-race avg.';
  const yearEnd = withForecast ? 2026 : years[years.length - 1];
  const shown = [];
  if (showOffice) shown.push(...officePts.flatMap(p => [p.place, showTexas ? p.texas : NaN]));
  if (showAvg) shown.push(...avgPts.flatMap(p => [p.place, showTexas ? p.texas : NaN]));
  const all = shown.filter(Number.isFinite);
  if (!all.length) all.push(.4, .6);
  const lo = Math.min(...all, withForecast && store.q05[i] ? store.q05[i] : 1), hi = Math.max(...all, withForecast && store.q95[i] ? store.q95[i] : 0);
  const step = hi - lo > .5 ? .2 : hi - lo > .2 ? .1 : .05;
  const yLo = Math.max(0, Math.floor((lo - .01) / step) * step), yHi = Math.min(1, Math.ceil((hi + .01) / step) * step);
  const width = Math.max(240, host.clientWidth || 320), height = 250, direct = width >= 460;
  const margin = { left:34, right:direct ? 142 : 16, top:12, bottom:24 };
  const x0 = years[0] - 1, x1 = yearEnd + 1;
  const x = year => margin.left + (year - x0) * (width - margin.left - margin.right) / (x1 - x0), y = v => height - margin.bottom - (v - yLo) / (yHi - yLo) * (height - margin.top - margin.bottom);
  const ticks = []; for (let v = yLo; v <= yHi + 1e-9; v += step) ticks.push(+v.toFixed(3));
  const tickYears = [...years, ...(withForecast ? [2026] : [])];
  const dot = (p, key, cls, r, diamond) => {
    if (!Number.isFinite(p[key])) return '';
    const cx = x(p.year).toFixed(1), cy = y(p[key]).toFixed(1), est = p.estimated ? ' tl-est' : '';
    return diamond ? `<rect class="tl-mark ${cls}${est}" x="${(x(p.year) - r).toFixed(1)}" y="${(y(p[key]) - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" transform="rotate(45 ${cx} ${cy})"/>` : `<circle class="tl-mark ${cls}${est}" cx="${cx}" cy="${cy}" r="${r}"/>`;
  };
  const axis = ticks.map(v => `<line class="tl-grid${Math.abs(v - .5) < 1e-9 ? ' half' : ''}" x1="${margin.left}" x2="${width - margin.right}" y1="${y(v)}" y2="${y(v)}"/><text class="tl-axis" x="${margin.left - 4}" y="${y(v) + 3}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('');
  const sparse = (x(2004) - x(2002)) < 26;
  const labels = tickYears.filter(year => !sparse || year === 2026 || (year - years[0]) % 4 === 0).map(year => `<text class="tl-axis" x="${x(year)}" y="${height - 6}" text-anchor="middle">${year === 2026 ? "'26 fcst" : `'${String(year).slice(2)}`}</text>`).join('');
  const xf = x(2026), qLo = store.q05[i], qHi = store.q95[i];
  const bar = withForecast && Number.isFinite(qLo) && Number.isFinite(qHi) ? `<line class="tl-range" x1="${xf}" x2="${xf}" y1="${y(qLo)}" y2="${y(qHi)}"/><line class="tl-cap" x1="${xf - 4}" x2="${xf + 4}" y1="${y(qLo)}" y2="${y(qLo)}"/><line class="tl-cap" x1="${xf - 4}" x2="${xf + 4}" y1="${y(qHi)}" y2="${y(qHi)}"/>` : '';
  const smooth = (p, q) => `M${x(p.year).toFixed(1)},${y(p.place).toFixed(1)}C${((x(p.year) + x(q.year)) / 2).toFixed(1)},${y(p.place).toFixed(1)} ${((x(p.year) + x(q.year)) / 2).toFixed(1)},${y(q.place).toFixed(1)} ${x(q.year).toFixed(1)},${y(q.place).toFixed(1)}`;
  const fcPt = officePts.find(p => p.forecast), lastPast = officePts.filter(p => !p.forecast && Number.isFinite(p.place)).pop();
  const projected = fcPt && lastPast && Number.isFinite(fcPt.place) ? `<path class="tl-line tl-place tl-projected" d="${smooth(lastPast, fcPt)}"/>` : '';
  const layer = (pointsList, kind, key, cls, r, diamond) => `<path class="tl-line ${cls}${kind === 'avg' ? ' tl-avg' : ''}" d="${path(pointsList, key)}"/>${pointsList.map(p => dot(p, key, cls, r, diamond)).join('')}`;
  const path = (list, key) => { let d = '', prev = false; for (const p of list) { if (p.forecast) continue; if (Number.isFinite(p[key])) { d += `${prev ? 'L' : 'M'}${x(p.year).toFixed(1)},${y(p[key]).toFixed(1)}`; prev = true; } else prev = false; } return d; };
  const seriesSvg = [
    showAvg && showTexas ? layer(avgPts, 'avg', 'texas', 'tl-state', 2.6, true) : '',
    showOffice && showTexas ? layer(officePts, 'office', 'texas', 'tl-state', 2.4, false) : '',
    showAvg ? layer(avgPts, 'avg', 'place', 'tl-place', 3.4, true) : '',
    showOffice ? `${layer(officePts, 'office', 'place', 'tl-place', 3.8, false)}${projected}${bar}` : '',
  ].join('');
  // Direct labels at the right end of each visible line, nudged apart; the legend replaces them when the panel is narrow.
  const keyed = [];
  const lastOf = (list, key) => [...list].reverse().find(p => Number.isFinite(p[key]));
  if (showOffice) { keyed.push({ cls:'tl-place', text:`${placeName} · ${officeLabel}`, last:lastOf(officePts, 'place') }); if (showTexas) keyed.push({ cls:'tl-state', text:`Texas · ${officeLabel}`, last:lastOf(officePts, 'texas') }); }
  if (showAvg) { keyed.push({ cls:'tl-place', text:`${placeName} · all-race avg.`, tip:avgTip, last:lastOf(avgPts, 'place'), avg:true }); if (showTexas) keyed.push({ cls:'tl-state', text:'Texas · all-race avg.', tip:avgTip, last:lastOf(avgPts, 'texas'), avg:true }); }
  const placed = keyed.filter(k => k.last).map(k => ({ ...k, y:y(k.last[k.cls === 'tl-place' ? 'place' : 'texas']) })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < placed.length; k++) if (placed[k].y - placed[k - 1].y < 11) placed[k].y = placed[k - 1].y + 11;
  const directSvg = direct ? placed.map(k => `<text class="tl-direct ${k.cls}" x="${width - margin.right + 7}" y="${(k.y + 3).toFixed(1)}">${k.tip ? `<title>${escapeHTML(k.tip)}</title>` : `<title>${escapeHTML(k.text)}</title>`}${escapeHTML(k.suffix ? `${clip(placeFull, 31 - k.suffix.length)}${k.suffix}` : k.text)}</text>`).join('') : '';
  const legendHtml = direct ? '' : `<div class="tl-legend" aria-label="Lines shown">${keyed.map(k => `<span${k.tip ? ` title="${escapeHTML(k.tip)}"` : ''}><i class="tl-key ${k.cls === 'tl-place' ? 'place' : 'state'}${k.avg ? ' avg' : ''}"></i>${escapeHTML(k.text)}</span>`).join('')}</div>`;
  const hitPts = [...(showAvg ? avgPts.map(p => ({ ...p, tip:true, clickable:compareSeries === 'avg' })) : []), ...(showOffice ? officePts.map(p => ({ ...p, tip:true, clickable:compareSeries === 'office' })) : [])];
  const hits = hitPts.filter(p => Number.isFinite(p.place)).map(p => `<circle class="tl-hit${p.clickable ? ' tl-pick' : ''}" cx="${x(p.year).toFixed(1)}" cy="${y(p.place).toFixed(1)}" r="9" data-id="${p.id}" tabindex="0" role="${p.clickable ? 'button' : 'img'}" aria-label="${escapeHTML(tipText(p))}"/>`).join('');
  function tipText(p) {
    const tx = showTexas && Number.isFinite(p.texas) ? `  ·  Texas: ${pct(p.texas)}  ·  gap ${gapText(p.place - p.texas)}` : '';
    return `${p.head}  ${dash}  ${placeFull}: ${pct(p.place)}${tx}`;
  }
  host.innerHTML = `<h3>Share over time</h3>
    <div class="tl-tabs" role="group" aria-label="Office shown">${offices.map(([key, label]) => `<button type="button" class="tl-tab" data-office="${key}" aria-pressed="${key === office}">${label}</button>`).join('')}</div>
    <div class="tl-controls"><div class="tl-series" role="group" aria-label="Series shown">
      <button type="button" class="tl-ser" data-ser="office" aria-pressed="${showOffice}"${showOffice && !showAvg ? ' aria-disabled="true"' : ''}>${officeLabel}</button>
      <button type="button" class="tl-ser" data-ser="avg" aria-pressed="${showAvg}"${showAvg && !showOffice ? ' aria-disabled="true"' : ''} title="${escapeHTML(avgTip)}">All-race average</button></div>
      <label class="tl-check"><input type="checkbox" class="tl-texas"${showTexas ? ' checked' : ''}> Compare with Texas</label></div>
    <div class="tl-plot"><svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="group" aria-label="Democratic two-party share, ${officeLabel} races and the all-race average">
      ${axis}${labels}${seriesSvg}${directSvg}
      <g class="tl-rings"></g><g class="tl-hits">${hits}</g>
    </svg><div class="tl-tip" hidden></div></div>
    ${legendHtml}
    <p class="note tl-source">2002–2014 estimated on today's precinct lines from older precinct returns.</p>
    <p class="note tl-hint"></p>`;
  if (results) renderResults(results, ownRaces, row, options.cell);

  const svg = host.querySelector('svg'), rings = svg.querySelector('.tl-rings'), hint = host.querySelector('.tl-hint'), tip = host.querySelector('.tl-tip'), plot = host.querySelector('.tl-plot');
  const byId = new Map(hitPts.map(p => [p.id, p]));
  const showTip = hit => {
    const p = byId.get(hit.dataset.id); if (!p) return;
    tip.textContent = tipText(p); tip.hidden = false;
    const box = plot.getBoundingClientRect(), r = hit.getBoundingClientRect();
    const left = Math.min(Math.max(0, r.left - box.left + r.width / 2 - tip.offsetWidth / 2), Math.max(0, box.width - tip.offsetWidth));
    tip.style.left = `${left}px`; tip.style.top = `${Math.max(0, r.top - box.top - tip.offsetHeight - 6)}px`;
  };
  svg.addEventListener('pointerover', event => { const hit = event.target.closest('.tl-hit'); if (hit) showTip(hit); });
  svg.addEventListener('pointerout', event => { if (event.target.closest('.tl-hit')) tip.hidden = true; });
  svg.addEventListener('focusin', event => { const hit = event.target.closest('.tl-hit'); if (hit) showTip(hit); });
  svg.addEventListener('focusout', () => { tip.hidden = true; });

  host.querySelector('.tl-series').addEventListener('click', event => {
    const button = event.target.closest('.tl-ser'); if (!button || button.getAttribute('aria-disabled') === 'true') return;
    if (button.dataset.ser === 'office') showOffice = !showOffice; else showAvg = !showAvg;
    renderTimeline(host, level, regionId, options);
  });
  host.querySelector('.tl-texas').addEventListener('change', event => { compareTexas = event.target.checked; renderTimeline(host, level, regionId, options); });
  host.querySelector('.tl-tabs').addEventListener('click', event => { const tab = event.target.closest('.tl-tab'); if (tab && tab.dataset.office !== office) { office = tab.dataset.office; renderTimeline(host, level, regionId, options); } });

  // Default pair: the last two actual results of the compared series.
  const actual = pts.filter(p => !p.forecast && Number.isFinite(p.place));
  let pair = actual.length >= 2 ? { a:actual[actual.length - 2].id, b:actual[actual.length - 1].id } : null;
  let first = null;
  const find = id => pts.find(p => p.id === id);
  const drawRings = () => {
    const A = pair && find(pair.a), B = pair && find(pair.b);
    rings.innerHTML = [...[A, B].filter(Boolean).map(p => ({ p, cls:'active' })), ...(first ? [{ p:find(first), cls:'pending' }] : [])].filter(({ p }) => p && Number.isFinite(p.place)).map(({ p, cls }) => `<circle class="tl-ring ${cls}" cx="${x(p.year).toFixed(1)}" cy="${y(p.place).toFixed(1)}" r="7"/>`).join('');
    if (first) { hint.textContent = `${find(first).forecast ? '2026 forecast' : `${nameOf} ${find(first).year}`} selected. Click a second point to compare.`; return; }
    if (!A || !B) { hint.textContent = 'Click two points to compare them.'; return; }
    const name = p => p.forecast ? '2026 forecast' : String(p.year);
    hint.textContent = `${nameOf} ${A.year} → ${name(B)}: ${pct(A.place)} → ${pct(B.place)} (${signed(B.place - A.place)}). Click two points to compare others.`;
  };
  const pick = id => {
    if (!first) { first = id; drawRings(); return; }
    if (first === id) { first = null; drawRings(); return; }
    const [a, b] = [find(first), find(id)].sort((u, v) => u.year - v.year);
    first = null;
    pair = { a:a.id, b:b.id };
    if (compareSeries === 'office' && a.cmp && b.cmp) { setState({ from:a.cmp, to:b.cmp }); window.dispatchEvent(new Event('show-comparison')); } else drawRings();
  };
  svg.addEventListener('click', event => { const hit = event.target.closest('.tl-pick'); if (hit) pick(hit.dataset.id); });
  svg.addEventListener('keydown', event => { const hit = event.target.closest('.tl-pick'); if (hit && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); pick(hit.dataset.id); } });
  const onChange = () => {
    if (!host.isConnected || compareSeries !== 'office') return;
    const a = officePts.find(p => p.cmp === state.from), b = officePts.find(p => p.cmp === state.to);
    if (a && b) pair = { a:a.id, b:b.id };
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
