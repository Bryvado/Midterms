import { base, csv, pct, count, escapeHTML } from './data.js';

// Early-vote totals from the Secretary of State, published by the model as county and statewide-by-date files.
// Both files are optional: without them the panel, its toolbar button and the map measures stay hidden.
export const earlyMeasures = [
  { key:'ev_pct_registered', column:'pct_registered', label:'Early vote: % of registered' },
  { key:'ev_pct_of_2022_total', column:'pct_of_2022_total', label:'Early vote: % of 2022 turnout' },
  { key:'ev_pct_of_expected', column:'pct_of_expected', label:'Early vote: % of expected ballots' },
];
export const isEarlyMeasure = key => typeof key === 'string' && key.startsWith('ev_pct');
const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
// Shares may be published as fractions or as percents; both read as fractions here.
const asShare = (rows, column) => {
  const values = rows.map(row => num(row[column]));
  const scale = values.some(v => v > 1.5) ? 100 : 1;
  return values.map(v => v / scale);
};
let loaded;
export function loadEarlyVote() {
  loaded ||= fetch(`${base}data/optional.json`).then(r => r.ok ? r.json() : []).catch(() => [])
    .then(present => ['early_vote_county.csv', 'early_vote_daily.csv'].every(f => present.includes(f)) ? Promise.all([csv('early_vote_county.csv'), csv('early_vote_daily.csv')]) : [[], []])
    .then(([county, daily]) => {
    if (!county.length || !daily.length) return null;
    for (const m of earlyMeasures) asShare(county, m.column).forEach((v, i) => { county[i][m.key] = v; });
    const shares = Object.fromEntries(['pct_registered', 'pct_of_2022_total', 'pct_of_expected'].map(c => [c, asShare(daily, c)]));
    daily.forEach((row, i) => { for (const c of Object.keys(shares)) row[`share_${c}`] = shares[c][i]; });
    daily.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return { county, daily, byId:new Map(county.map(row => [String(row.county_fips3).padStart(3, '0'), row])) };
  }).catch(() => null);
  return loaded;
}
// Values by county fips for one map measure; the map looks counties up by region_id.
export async function earlyValues(key) {
  const data = await loadEarlyVote();
  const out = {};
  if (data) for (const [id, row] of data.byId) if (Number.isFinite(row[key])) out[id] = row[key];
  return out;
}

const panel = document.querySelector('#fp-early');
const dateText = d => { const t = new Date(`${d}T12:00:00`); return Number.isNaN(+t) ? String(d) : t.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); };
const tableState = { sort:'total_early', dir:-1 };
const columns = [
  { key:'county', label:'County', text:true },
  { key:'total_early', label:'Total early', show:count }, { key:'in_person', label:'In person', show:count }, { key:'mail', label:'Mail', show:count },
  { key:'ev_pct_registered', label:'% registered', show:v => pct(v) }, { key:'ev_pct_of_2022_total', label:'% of 2022', show:v => pct(v) }, { key:'ev_pct_of_expected', label:'% of expected', show:v => pct(v) },
];

function strip(latest) {
  const cell = (label, value, sub = '') => `<div class="ev-stat"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong>${sub ? `<em>${escapeHTML(sub)}</em>` : ''}</div>`;
  const total = num(latest.total_early), person = num(latest.in_person), mail = num(latest.mail);
  return cell('Early votes', count(total), `through ${dateText(latest.date)}`)
    + cell('In person · mail', `${count(person)} · ${count(mail)}`, total > 0 ? `${pct(person / total, 0)} in person` : '')
    + cell('Of registered', pct(latest.share_pct_registered))
    + cell('Of 2022 turnout', pct(latest.share_pct_of_2022_total))
    + cell("Of the model's expected ballots", pct(latest.share_pct_of_expected));
}

function chart(daily, host) {
  const width = Math.max(260, host.clientWidth || 360), height = 190, m = { top:12, right:12, bottom:22, left:46 };
  const rows = daily.filter(row => Number.isFinite(num(row.in_person)) && Number.isFinite(num(row.mail)));
  if (!rows.length) { host.innerHTML = ''; return; }
  const expected = num(daily.at(-1).expected_ballots);
  const top = Math.max(...rows.map(r => num(r.in_person) + num(r.mail)), Number.isFinite(expected) ? expected : 0) * 1.06;
  const n = rows.length, x = i => m.left + (n === 1 ? (width - m.left - m.right) / 2 : i * (width - m.left - m.right) / (n - 1)), y = v => height - m.bottom - v / top * (height - m.top - m.bottom);
  const area = (lo, hi) => `M${rows.map((r, i) => `${x(i).toFixed(1)},${y(hi(r)).toFixed(1)}`).join('L')}L${rows.map((r, i) => [i, r]).reverse().map(([i, r]) => `${x(i).toFixed(1)},${y(lo(r)).toFixed(1)}`).join('L')}Z`;
  const person = r => num(r.in_person), both = r => num(r.in_person) + num(r.mail);
  const ticks = [0, .25, .5, .75, 1].map(f => f * top);
  const short = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v));
  const every = Math.max(1, Math.ceil(n / 6));
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Cumulative early votes by date, in person and mail">
    ${ticks.map(v => `<line class="ev-grid" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/><text class="ev-axis" x="${m.left - 5}" y="${y(v) + 3}" text-anchor="end">${short(v)}</text>`).join('')}
    <path class="ev-area person" d="${area(() => 0, person)}"/><path class="ev-area mail" d="${area(person, both)}"/>
    ${Number.isFinite(expected) ? `<line class="ev-expected" x1="${m.left}" x2="${width - m.right}" y1="${y(expected)}" y2="${y(expected)}"/><text class="ev-expected-label" x="${width - m.right}" y="${y(expected) - 4}" text-anchor="end">Model's expected ballots: ${short(expected)}</text>` : ''}
    ${rows.map((r, i) => i % every && i !== n - 1 ? '' : `<text class="ev-axis" x="${x(i)}" y="${height - 6}" text-anchor="${n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle'}">${escapeHTML(dateText(r.date).replace(/, \d{4}$/, ''))}</text>`).join('')}
  </svg>
  <div class="ev-legend"><span><i class="ev-key person"></i>In person</span><span><i class="ev-key mail"></i>Mail</span><span><i class="ev-key expected"></i>Model's expected total ballots</span></div>`;
}

function table(county, host) {
  const col = columns.find(c => c.key === tableState.sort) || columns[1];
  const value = (row, c) => c.text ? String(row[c.key] || '') : c.key.startsWith('ev_') ? row[c.key] : num(row[c.key]);
  const sorted = [...county].sort((a, b) => { const p = value(a, col), q = value(b, col); return (col.text ? p.localeCompare(q) : (Number.isFinite(p) ? p : -Infinity) - (Number.isFinite(q) ? q : -Infinity)) * tableState.dir; });
  host.innerHTML = `<div class="table-scroll ev-table"><table><thead><tr>${columns.map(c => `<th class="${c.text ? 'name' : ''}" aria-sort="${c.key === col.key ? (tableState.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-ev-sort="${c.key}">${escapeHTML(c.label)}</button></th>`).join('')}</tr></thead>
    <tbody>${sorted.map(row => `<tr>${columns.map(c => `<td class="${c.text ? 'name' : ''}">${escapeHTML(c.text ? value(row, c) : Number.isFinite(value(row, c)) ? c.show(value(row, c)) : 'n/a')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export async function initEarlyVote() {
  const data = await loadEarlyVote();
  for (const button of document.querySelectorAll('[data-open-panel="early"]')) button.hidden = !data;
  if (!data || !panel) return data;
  const latest = data.daily.at(-1);
  panel.querySelector('#ev-strip').innerHTML = strip(latest);
  const draw = () => { if (!panel.hidden) chart(data.daily, panel.querySelector('#ev-chart')); };
  table(data.county, panel.querySelector('#ev-table'));
  panel.querySelector('#ev-table').addEventListener('click', event => {
    const button = event.target.closest('[data-ev-sort]');
    if (!button) return;
    const key = button.dataset.evSort;
    if (tableState.sort === key) tableState.dir = -tableState.dir; else { tableState.sort = key; tableState.dir = columns.find(c => c.key === key).text ? 1 : -1; }
    table(data.county, panel.querySelector('#ev-table'));
  });
  new ResizeObserver(draw).observe(panel);
  window.addEventListener('panel-layout', draw);
  draw();
  return data;
}
