import { base, csv, pct, count, escapeHTML } from './data.js';

// Early-vote map mode. The R pipeline publishes one row per region per early-voting day, cumulative through that day.
// Blank cells are withheld on purpose (fewer than 10 voters); they are shown as withheld and never filled in or derived.
const files = { precinct:'early_vote_map_precinct.csv', puma:'early_vote_map_puma.csv', county:'early_vote_map_county.csv' };
export const evLevels = Object.keys(files);
export const evMeasures = [
  { key:'pct_registered', label:'% of registered voters', kind:'share' },
  { key:'pct_of_2022', label:'% of 2022 turnout', kind:'share' },
  { key:'pct_of_expected', label:"% of the model's expected ballots", kind:'share' },
  { key:'early_ballots', label:'Early ballots', kind:'count' },
  { key:'d_share_primary_history', label:'D share of early voters with a 2026 primary history', kind:'dshare' },
];
export const EV_KEY = 'evmap';
const params = new URLSearchParams(location.search);
export const ev = { on:params.has('ev'), measure:evMeasures.some(m => m.key === params.get('ev')) ? params.get('ev') : 'pct_registered', date:params.get('evd') || null };
const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
const measureOf = key => evMeasures.find(m => m.key === key) || evMeasures[0];
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : NaN;

const cache = new Map();
// Each level's file is read once, on first use, and kept; switching dates only filters in memory.
export function loadEv(level) {
  if (!files[level]) return Promise.resolve(null);
  if (!cache.has(level)) cache.set(level, csv(files[level]).then(rows => {
    const byDate = new Map();
    for (const row of rows) {
      const id = String(row.region_id);
      if (!byDate.has(row.date)) byDate.set(row.date, new Map());
      byDate.get(row.date).set(id, row);
    }
    const dates = [...byDate.keys()].sort();
    // Fixed ranges per measure across every date, so moving the slider shows real change.
    const ranges = {};
    for (const m of evMeasures) {
      const values = rows.map(row => num(row[m.key])).filter(Number.isFinite);
      if (m.kind === 'dshare') {
        const d = quantile(values.map(v => Math.abs(v - .5)).sort((a, b) => a - b), .99);
        const half = Number.isFinite(d) && d > 0 ? d : .1;
        ranges[m.key] = [.5 - half, .5 + half];
      } else {
        const hi = quantile(values.sort((a, b) => a - b), .99);
        ranges[m.key] = [0, Number.isFinite(hi) && hi > 0 ? hi : 1];
      }
    }
    return { dates, byDate, ranges };
  }).catch(error => { cache.delete(level); throw error; }));
  return cache.get(level);
}
const loadedFor = new Map();
export async function ensureEv(level) {
  const data = await loadEv(level);
  loadedFor.set(level, data);
  if (data && (!ev.date || !data.dates.includes(ev.date))) ev.date = data.dates.at(-1);
  syncDateControl(data);
  return data;
}
const evData = level => loadedFor.get(level) || null;

// What the map needs for one level at the current date and measure: values to shade, ids to hatch, and the fixed range.
export function evColorData(level) {
  const data = evData(level);
  if (!data) return null;
  const m = measureOf(ev.measure), rows = data.byDate.get(ev.date) || new Map();
  const values = {}, withheld = [];
  for (const [id, row] of rows) {
    const v = num(row[m.key]);
    if (Number.isFinite(v)) values[id] = v; else withheld.push(id);
  }
  return { values, withheld, range:data.ranges[m.key], diverging:m.kind === 'dshare', measure:m };
}
// Counts below 10 are never displayed, even when a published cell holds one.
const shown = n => !Number.isFinite(n) ? 'under 10' : n < 10 ? 'under 10' : count(n);
export const formatEv = (kind, v) => !Number.isFinite(v) ? 'n/a' : kind === 'count' ? count(v) : pct(v);
const dateText = d => { const t = new Date(`${d}T12:00:00`); return Number.isNaN(+t) ? String(d) : t.toLocaleDateString('en-US', { month:'short', day:'numeric' }); };
export const evTitle = () => `Early vote: ${measureOf(ev.measure).label}${ev.date ? `, through ${dateText(ev.date)}` : ''}`;

export function evTooltip(props, level) {
  const label = props.region_label || props.region_id || 'Selected place';
  const row = evData(level)?.byDate.get(ev.date)?.get(String(props.region_id));
  const head = `<strong>${escapeHTML(label)}</strong>Through ${escapeHTML(dateText(ev.date))}<br>`;
  if (!row) return `${head}No early-vote record for this area.`;
  const v = key => num(row[key]);
  if (!Number.isFinite(v('early_ballots'))) return `${head}Fewer than 10 early voters.`;
  const lines = [
    `Early ballots: ${shown(v('early_ballots'))} (${shown(v('in_person'))} in person / ${shown(v('mail'))} mail)`,
    `% of registered voters: ${formatEv('share', v('pct_registered'))}`,
    `% of 2022 turnout: ${formatEv('share', v('pct_of_2022'))}`,
    `% of the model's expected ballots: ${formatEv('share', v('pct_of_expected'))}`,
    Number.isFinite(v('d_share_primary_history')) && Number.isFinite(v('with_primary_history'))
      ? `D share with a 2026 primary history: ${pct(v('d_share_primary_history'))} of ${count(v('with_primary_history'))}`
      : 'D share: fewer than 10 with a primary history',
  ];
  return head + lines.map(escapeHTML).join('<br>');
}
export const withheldText = () => measureOf(ev.measure).kind === 'dshare' ? 'Fewer than 10 with a primary history' : 'Fewer than 10 early voters';

// ---- Controls in the Map controls panel ----
const box = document.querySelector('#ev-controls');
const toggle = document.querySelector('#ev-toggle');
const select = box?.querySelector('#ev-measure');
const slider = box?.querySelector('#ev-date');
const dateLabel = box?.querySelector('#ev-date-label');
const play = box?.querySelector('#ev-play');
let timer = null;
const emit = () => window.dispatchEvent(new Event('evmap-change'));
function writeURL() {
  const url = new URL(location.href);
  if (ev.on) { url.searchParams.set('ev', ev.measure); if (ev.date) url.searchParams.set('evd', ev.date); } else { url.searchParams.delete('ev'); url.searchParams.delete('evd'); }
  history.replaceState(null, '', url);
}
function syncDateControl(data) {
  if (!slider || !data) return;
  slider.max = String(data.dates.length - 1);
  slider.value = String(Math.max(0, data.dates.indexOf(ev.date)));
  slider.dataset.dates = data.dates.join(',');
  dateLabel.textContent = ev.date ? `Through ${dateText(ev.date)}` : '';
  writeURL();
}
function stop() { clearInterval(timer); timer = null; if (play) { play.textContent = 'Play'; play.setAttribute('aria-pressed', 'false'); } }
function setDate(index) {
  const dates = (slider.dataset.dates || '').split(',').filter(Boolean);
  if (!dates.length) return;
  ev.date = dates[Math.max(0, Math.min(dates.length - 1, index))];
  slider.value = String(dates.indexOf(ev.date));
  dateLabel.textContent = `Through ${dateText(ev.date)}`;
  writeURL(); emit();
}
export function syncEvControls() {
  if (!box) return;
  toggle.checked = ev.on;
  box.hidden = !ev.on;
  document.querySelector('.measure-label')?.toggleAttribute('hidden', ev.on);
  document.querySelector('#compare-group')?.classList.toggle('ev-hide', ev.on);
  for (const button of document.querySelectorAll('[data-unit]')) {
    const off = ev.on && !evLevels.includes(button.dataset.unit);
    button.disabled = off;
    button.title = off ? 'Early vote is published for precincts, PUMAs and counties' : button.dataset.title || button.title;
  }
  select.value = ev.measure;
}
if (box) {
  for (const button of document.querySelectorAll('[data-unit]')) button.dataset.title = button.title || '';
  select.replaceChildren(...evMeasures.map(m => new Option(m.label, m.key, false, m.key === ev.measure)));
  toggle.addEventListener('change', () => {
    ev.on = toggle.checked;
    if (!ev.on) stop();
    syncEvControls(); writeURL();
    window.dispatchEvent(new CustomEvent('evmap-mode', { detail:{ on:ev.on } }));
  });
  select.addEventListener('change', () => { ev.measure = select.value; writeURL(); emit(); });
  slider.addEventListener('input', () => { stop(); setDate(+slider.value); });
  play.addEventListener('click', () => {
    if (timer) return stop();
    const dates = (slider.dataset.dates || '').split(',').filter(Boolean);
    if (+slider.value >= dates.length - 1) setDate(0);
    play.textContent = 'Pause'; play.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => { const next = +slider.value + 1; if (next >= dates.length) return stop(); setDate(next); }, 1100);
  });
  syncEvControls();
  // The toggle appears only when the county file is published (staging lists published optional files in optional.json).
  const wrap = toggle.closest('label');
  wrap.hidden = true;
  fetch(`${base}data/optional.json`).then(r => r.ok ? r.json() : []).catch(() => []).then(present => {
    wrap.hidden = !present.includes(files.county);
    if (wrap.hidden && ev.on) { ev.on = false; syncEvControls(); writeURL(); }
  });
}
