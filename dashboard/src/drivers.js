import { csv, pct, count, escapeHTML } from './data.js';
import { partyColor } from './map.js';

// drivers.csv names levels differently from the map; ids are compared as the strings both files carry.
const driverLevel = { precinct:'precinct', county:'county', cd:'congressional_district', cousub:'county_subdivision', puma:'puma' };
const stepNames = [['baseline_adj', 'Baseline adjustment'], ['statewide_shift', 'Statewide shift'], ['reversion', 'Reversion'], ['other', 'Other']];
const finite = v => v !== '' && v != null && v !== 'NA' && Number.isFinite(+v);
let index;

function load() {
  index ||= csv('drivers.csv').then(rows => new Map(rows.map(row => [`${row.level}|${row.region_id}`, row]))).catch(error => { index = null; throw error; });
  return index;
}

export async function driversFor(unit, regionId) {
  return (await load()).get(`${driverLevel[unit]}|${regionId}`) || null;
}

// A step that rounds to zero shows without a sign.
const points = v => { const text = Math.abs(100 * v).toFixed(1); return `${text === '0.0' ? '' : v >= 0 ? '+' : '−'}${text} pp`; };

// Steps are Talarico two-party share, shown in percentage points. Nothing is recomputed: each bar is a published column.
function waterfall(row) {
  const complete = ['start_2024', ...stepNames.map(([key]) => key), 'forecast'].every(key => finite(row[key]));
  const rows = [];
  if (finite(row.start_2024)) rows.push({ label:'2024 Harris share', kind:'total', value:+row.start_2024 });
  let running = finite(row.start_2024) ? +row.start_2024 : null;
  if (complete) for (const [key, label] of stepNames) { const from = running; running += +row[key]; rows.push({ label, kind:'step', from, to:running, delta:+row[key] }); }
  if (finite(row.forecast)) rows.push({ label:'2026 forecast', kind:'total', value:+row.forecast });
  const values = rows.flatMap(r => r.kind === 'total' ? [r.value] : [r.from, r.to]);
  const low = Math.min(...values, .5), high = Math.max(...values, .5), pad = Math.max(.01, (high - low) * .08);
  const width = 300, left = 104, right = width - 46, rowH = 19, top = 4, axisH = 16, height = top + rows.length * rowH + axisH;
  const x = v => left + (v - (low - pad)) / (high - low + 2 * pad) * (right - left);
  const ticks = [];
  const span = high - low + 2 * pad, step = span > .4 ? .1 : span > .15 ? .05 : .02;
  for (let t = Math.ceil((low - pad) / step) * step; t <= high + pad + 1e-9; t += step) ticks.push(+t.toFixed(3));
  const label = (px, y, text, cls) => px > right - 2 ? `<text class="drv-value ${cls}" x="${px - 5}" y="${y + 3.5}" text-anchor="end">${escapeHTML(text)}</text>` : `<text class="drv-value ${cls}" x="${px + 5}" y="${y + 3.5}">${escapeHTML(text)}</text>`;
  const marks = rows.map((r, i) => {
    const y = top + i * rowH + rowH / 2;
    const name = `<text class="drv-name${r.kind === 'total' ? ' total' : ''}" x="0" y="${y + 3.5}">${escapeHTML(r.label)}</text>`;
    if (r.kind === 'total') {
      const cx = x(r.value);
      return `${name}<path class="drv-total" d="M${cx},${y - 6}L${cx + 6},${y}L${cx},${y + 6}L${cx - 6},${y}Z"/>${label(cx + 6, y, pct(r.value), 'total')}`;
    }
    const a = x(Math.min(r.from, r.to)), b = x(Math.max(r.from, r.to));
    const color = r.delta >= 0 ? partyColor('D') : partyColor('R');
    return `${name}<rect class="drv-step" x="${a}" y="${y - 5.5}" width="${Math.max(1.5, b - a)}" height="11" rx="1.5" fill="${color}"/>${label(b, y, points(r.delta), '')}`;
  }).join('');
  // Thin connectors carry the running level from one row to the next.
  const links = rows.slice(0, -1).map((r, i) => {
    const level = r.kind === 'total' ? r.value : r.to;
    return `<line class="drv-link" x1="${x(level)}" x2="${x(level)}" y1="${top + i * rowH + rowH / 2 + 6}" y2="${top + (i + 1) * rowH + rowH / 2 - 6}"/>`;
  }).join('');
  const axis = ticks.map(t => `<g><line class="drv-grid${Math.abs(t - .5) < 1e-9 ? ' center' : ''}" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${height - axisH}"/><text class="drv-axis" x="${x(t)}" y="${height - 3}" text-anchor="middle">${Math.round(t * 100)}%</text></g>`).join('');
  const aria = `Path from the 2024 Harris share to the 2026 forecast: ${rows.map(r => r.kind === 'total' ? `${r.label} ${pct(r.value)}` : `${r.label} ${points(r.delta)}`).join(', ')}.`;
  return { complete, svg:`<svg class="drv-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(aria)}">${axis}${links}${marks}</svg>` };
}

export function driversHTML(unit, row) {
  if (!row) return `<section class="drivers"><h3>From 2024 to the forecast</h3><p class="note">No driver breakdown is published for this place.</p></section>`;
  if (unit === 'precinct' && finite(row.expected_ballots) && +row.expected_ballots < .5) {
    return `<section class="drivers"><h3>From 2024 to the forecast</h3><p class="note">No expected ballots in this precinct, so no breakdown is shown.</p></section>`;
  }
  const { complete, svg } = waterfall(row);
  const scenario = (name, key) => `<div class="drv-scen"><span>${escapeHTML(name)}</span><strong>${finite(row[key]) ? points(+row[key]) : 'n/a'}</strong></div>`;
  return `<section class="drivers"><h3>From 2024 to the forecast</h3>
    ${svg}
    ${complete ? '' : '<p class="note">Step breakdown unavailable.</p>'}
    <div class="drv-scenarios" aria-label="Scenario change in Talarico two-party share">${scenario('Talarico best case', 'scen_talarico_p95_delta')}${scenario('Paxton best case', 'scen_paxton_p95_delta')}</div>
    <p class="drv-ballots">Expected ballots: <strong>${finite(row.expected_ballots) ? count(row.expected_ballots) : 'n/a'}</strong></p>
  </section>`;
}
