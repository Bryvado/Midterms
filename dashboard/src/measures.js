import { base, csv, pct, probPct, count, escapeHTML } from './data.js';

// Measure catalog shared by every scatter. ACS measures come only from demographics_measures.csv; the other groups are the
// model's existing published columns. A missing measures file leaves demographics out and everything else working.
const num = v => v === '' || v == null || v === 'NA' ? NaN : +v;
export const acsGroups = ['Age', 'Moving', 'Housing', 'Housing costs', 'Income', 'Education', 'Work', 'Origins', 'Households'];
export const otherGroups = ['Race and ethnicity', 'Model inputs', 'Politics', 'Early vote'];
// The measures file has no column marking tract-level inputs; these two are the ones the published note says come from tracts.
const tractMeasures = new Set(['pct_foreign_born', 'pct_noncitizen']);
const files = {
  precinct:{ details:'precinct_details.csv', projections:'regional_projections.csv', history:'history_precinct.csv', drivers:'precinct' },
  county:{ details:'county_details.csv', projections:'county_projections.csv', history:'history_county.csv', drivers:'county' },
  cd:{ details:'cd_details.csv', projections:'cd_projections.csv', history:'history_congressional_district.csv', drivers:'congressional_district' },
  cousub:{ details:'cousub_details.csv', projections:'cousub_projections.csv', history:'history_county_subdivision.csv', drivers:'county_subdivision' },
  puma:{ details:'puma_details.csv', projections:'puma_projections.csv', history:'history_puma.csv', drivers:'puma' },
};

let loaded;
export function loadDemographics() {
  loaded ||= fetch(`${base}data/optional.json`).then(r => r.ok ? r.json() : []).catch(() => [])
    .then(present => present.includes('demographics_measures.csv') ? csv('demographics_measures.csv') : null)
    .then(rows => {
      if (!rows?.length) return null;
      const sorted = [...rows].sort((a, b) => acsGroups.indexOf(a.group) - acsGroups.indexOf(b.group) || num(a.order) - num(b.order));
      const entries = sorted.map(r => ({ key:r.name, label:r.label, group:r.group, type:r.type, unit:r.unit, hasMoe:String(r.has_moe).toUpperCase() === 'TRUE', tract:tractMeasures.has(r.name), source:'details', acs:true }));
      return { entries, acsYear:rows[0].acs_year, note:rows[0].source_note };
    })
    .catch(() => null);
  return loaded;
}

// The method note reads the ACS years and source from the published measures file.
export function methodNote(acs) {
  const y = +acs.acsYear;
  return `Demographics are ACS 5-year estimates (${y - 4}-${y}) for residents, not voters, allocated from block groups to precincts by 2020 block population or housing units. Precinct values carry sampling margins of several points (median 90% margin: 65+ 4 points, renters 9, bachelor's 7, moved since 2010 10, foreign born 4). The binned view averages that noise out. Source: ${acs.note}.`;
}

// Existing model columns, grouped and labelled so the older inputs are not confused with the ACS measures.
export async function modelEntries() {
  const shifts = await csv('uniform_shift.csv').catch(() => []);
  const history = await csv('history_races.csv').catch(() => []);
  const years = [...new Set(history.map(r => r.year))].sort();
  return [
    { key:'hisp_cvap_share', label:'Hispanic share of citizen adults (CVAP)', group:'Race and ethnicity', type:'share', unit:'share', source:'details' },
    { key:'white_cvap_share', label:'White share of citizen adults (CVAP)', group:'Race and ethnicity', type:'share', unit:'share', source:'details' },
    { key:'black_cvap_share', label:'Black share of citizen adults (CVAP)', group:'Race and ethnicity', type:'share', unit:'share', source:'details' },
    { key:'ba_plus_share', label:"Bachelor's or higher (model input, older source)", group:'Model inputs', type:'share', unit:'share', source:'details' },
    { key:'med_income', label:'Median income (model input, older source)', group:'Model inputs', type:'median', unit:'dollars', source:'details' },
    { key:'registered_2024', label:'Registered voters, 2024', group:'Model inputs', type:'count', unit:'count', source:'details' },
    { key:'voted_2022', label:'Voted in 2022', group:'Model inputs', type:'count', unit:'count', source:'details' },
    { key:'density', label:'Population density (people per sq mi)', group:'Model inputs', type:'median', unit:'density', source:'density' },
    { key:'base_pres24', label:'2024 Harris two-party share', group:'Politics', type:'share', unit:'share', source:'projections' },
    { key:'mean', label:'Forecast Talarico two-party share', group:'Politics', type:'share', unit:'share', source:'projections' },
    { key:'p_talarico', label:'Forecast lean (Talarico win probability)', group:'Politics', type:'prob', unit:'prob', source:'projections' },
    ...shifts.filter(r => r.component === 'combined').map(r => ({ key:`shift_${r.baseline}`, label:`Forecast shift from ${r.label}`, group:'Politics', type:'shift', unit:'points', source:'projections' })),
    { key:'baseline_adj', label:'Forecast driver: baseline adjustment', group:'Politics', type:'shift', unit:'points', source:'drivers' },
    { key:'statewide_shift', label:'Forecast driver: statewide shift', group:'Politics', type:'shift', unit:'points', source:'drivers' },
    { key:'reversion', label:'Forecast driver: reversion', group:'Politics', type:'shift', unit:'points', source:'drivers' },
    { key:'other', label:'Forecast driver: other', group:'Politics', type:'shift', unit:'points', source:'drivers' },
    ...years.map(y => ({ key:`avg2p_${y}`, label:`Democratic two-party share, ${y} statewide races (average)`, group:'Politics', type:'share', unit:'share', source:'history' })),
  ];
}
export const earlyVoteEntries = [
  { key:'ev_pace', label:'Pace vs model (early vote)', group:'Early vote', type:'pace', unit:'pace', source:'ev' },
  { key:'ev_pct_registered', label:'Early ballots per registered voter', group:'Early vote', type:'share', unit:'share', source:'ev' },
  { key:'ev_d_share', label:'D share of early voters with a primary history', group:'Early vote', type:'share', unit:'share', source:'ev' },
];

// Unit-aware text for one value.
export function fmt(entry, v) {
  if (!Number.isFinite(v)) return 'no value';
  switch (entry?.unit) {
    case 'share': return pct(v, 1);
    case 'dollars': return `$${Math.round(v).toLocaleString('en-US')}`;
    case 'year': return String(Math.round(v));
    case 'years': return `${v.toFixed(1)} yrs`;
    case 'minutes': return `${Math.round(v)} min`;
    case 'count': return count(v);
    case 'density': return `${Math.round(v).toLocaleString('en-US')} / sq mi`;
    case 'points': return `${v >= 0 ? '+' : '−'}${Math.abs(100 * v).toFixed(1)} pts`;
    case 'prob': return probPct(v);
    case 'pace': return `${v.toFixed(2)}×`;
    default: return String(+v.toFixed(3));
  }
}
// Axis ticks: shorter forms of the same units.
export function fmtTick(entry, v) {
  switch (entry?.unit) {
    case 'share': case 'prob': return `${Math.round(100 * v)}%`;
    case 'dollars': return Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
    case 'year': return String(Math.round(v));
    case 'years': return `${Math.round(v)}`;
    case 'minutes': return `${Math.round(v)}`;
    case 'count': case 'density': return Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v));
    case 'points': return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(100 * v))}`;
    case 'pace': return `${+v.toFixed(2)}×`;
    default: return String(+v.toFixed(2));
  }
}
// The step a slope is quoted per, and how to name it.
export function slopeUnit(entry) {
  switch (entry?.unit) {
    case 'share': case 'prob': return { step:.1, text:'per 10 points' };
    case 'points': return { step:.1, text:'per 10 points' };
    case 'dollars': return { step:10000, text:'per $10,000' };
    case 'year': case 'years': return { step:10, text:'per 10 years' };
    case 'minutes': return { step:10, text:'per 10 min' };
    case 'count': return { step:1000, text:'per 1,000' };
    case 'density': return { step:1000, text:'per 1,000 / sq mi' };
    case 'pace': return { step:.1, text:'per 0.1×' };
    default: return { step:1, text:'per unit' };
  }
}
// A change in the y measure, worded in its own units.
export function fmtDelta(entry, d) {
  const sign = d >= 0 ? '+' : '−', a = Math.abs(d);
  switch (entry?.unit) {
    case 'share': case 'prob': case 'points': return `${sign}${(100 * a).toFixed(1)} pts`;
    case 'dollars': return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
    case 'pace': return `${sign}${a.toFixed(3)}×`;
    case 'years': return `${sign}${a.toFixed(1)} yrs`;
    case 'year': return `${sign}${a.toFixed(1)} years`;
    case 'minutes': return `${sign}${a.toFixed(1)} min`;
    default: return `${sign}${+a.toPrecision(3)}`;
  }
}
// "Moved in 2010 or later: 42% ± 10 pts" for a share with a published margin.
export function withMargin(entry, v, moe) {
  if (entry?.unit === 'share' && Number.isFinite(v) && Number.isFinite(moe)) return `${pct(v, 0)} ± ${100 * moe < 1 ? (100 * moe).toFixed(1) : Math.round(100 * moe)} pts`;
  return fmt(entry, v);
}

// One table per level: every published column the catalog can ask for, as typed arrays with NaN for no value.
const tables = new Map();
export function levelTable(level) {
  const f = files[level];
  if (!f) return Promise.resolve(null);
  if (!tables.has(level)) tables.set(level, Promise.all([csv(f.details), csv(f.projections), csv(f.history).catch(() => []), csv('drivers.csv').catch(() => [])]).then(([details, projections, history, drivers]) => {
    const n = details.length, ids = details.map(r => String(r.region_id)), index = new Map(ids.map((id, i) => [id, i]));
    const proj = new Map(projections.map(r => [String(r.region_id), r])), hist = new Map(history.map(r => [String(r.region_id), r]));
    const drv = new Map(drivers.filter(r => r.level === f.drivers).map(r => [String(r.region_id), r]));
    const labels = ids.map(id => proj.get(id)?.region_label || id);
    const cols = new Map();
    const column = (key, source) => {
      const tag = `${source}:${key}`;
      if (!cols.has(tag)) {
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const id = ids[i];
          out[i] = source === 'details' ? num(details[i][key]) : source === 'projections' ? num(proj.get(id)?.[key]) : source === 'history' ? num(hist.get(id)?.[key])
            : source === 'drivers' ? num(drv.get(id)?.[key]) : source === 'density' ? (num(details[i].area_sqmi) > 0 ? num(details[i].population) / num(details[i].area_sqmi) : NaN) : NaN;
        }
        cols.set(tag, out);
      }
      return cols.get(tag);
    };
    return { level, n, ids, labels, index, column, has:key => details.columns.includes(key) };
  }).catch(error => { tables.delete(level); throw error; }));
  return tables.get(level);
}
// How many units have a value, so a picker only offers measures with at least 30 at this level.
export const MIN_UNITS = 30;
export function finiteCount(arr) { let k = 0; for (const v of arr) if (Number.isFinite(v)) k++; return k; }

// ---- Picker: a button that opens a searchable, grouped list ----
let pickerSeq = 0;
export function createPicker(host, { label, onChange }) {
  const id = `mp${++pickerSeq}`;
  host.classList.add('mpick');
  host.innerHTML = `<span class="mpick-label">${escapeHTML(label)}</span><button type="button" class="mpick-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-pop"><span class="mpick-value"></span><span aria-hidden="true">▾</span></button>
    <div class="mpick-pop" id="${id}-pop" hidden><input type="search" class="mpick-search" placeholder="Search measures" aria-label="Search ${escapeHTML(label)} measures" aria-controls="${id}-list"><ul class="mpick-list" id="${id}-list" role="listbox" aria-label="${escapeHTML(label)}"></ul></div>`;
  const button = host.querySelector('.mpick-button'), pop = host.querySelector('.mpick-pop'), search = host.querySelector('.mpick-search'), list = host.querySelector('.mpick-list');
  let entries = [], value = null, active = -1, visible = [];
  const order = g => { const i = [...acsGroups, ...otherGroups].indexOf(g); return i < 0 ? 99 : i; };
  function render() {
    const q = search.value.trim().toLowerCase();
    visible = entries.filter(e => !q || e.label.toLowerCase().includes(q) || e.group.toLowerCase().includes(q) || e.key.toLowerCase().includes(q));
    const groups = [...new Set(visible.map(e => e.group))].sort((a, b) => order(a) - order(b));
    visible = groups.flatMap(g => visible.filter(e => e.group === g));
    let k = 0;
    list.innerHTML = groups.map(g => `<li class="mpick-group" role="presentation">${escapeHTML(g)}</li>${visible.filter(e => e.group === g).map(e => `<li role="option" id="${id}-o${k}" data-i="${k++}" aria-selected="${e.key === value}" class="mpick-option${e.key === value ? ' current' : ''}">${escapeHTML(e.label)}${e.tract ? '<span class="mpick-badge">tract-level estimate</span>' : ''}</li>`).join('')}`).join('') || '<li class="mpick-empty" role="presentation">No measures match</li>';
    setActive(Math.max(0, visible.findIndex(e => e.key === value)));
  }
  function setActive(i) {
    active = Math.min(visible.length - 1, Math.max(0, i));
    for (const li of list.querySelectorAll('.mpick-option')) li.classList.toggle('active', +li.dataset.i === active);
    const li = list.querySelector(`[data-i="${active}"]`);
    if (li) { li.scrollIntoView({ block:'nearest' }); search.setAttribute('aria-activedescendant', li.id); }
  }
  function open() { pop.hidden = false; button.setAttribute('aria-expanded', 'true'); search.value = ''; render(); search.focus(); }
  function close(focus = true) { pop.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); }
  function choose(i) { const e = visible[i]; if (!e) return; value = e.key; sync(); close(); onChange(e.key); }
  function sync() { const e = entries.find(x => x.key === value); host.querySelector('.mpick-value').innerHTML = e ? `${escapeHTML(e.label)}${e.tract ? ' <span class="mpick-badge">tract-level</span>' : ''}` : 'Choose a measure'; button.title = e ? `${e.group}: ${e.label}` : ''; }
  button.addEventListener('click', () => pop.hidden ? open() : close());
  search.addEventListener('input', render);
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  });
  list.addEventListener('pointerdown', e => { const li = e.target.closest('.mpick-option'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !host.contains(e.target)) close(false); });
  return {
    set(list2, v) { entries = list2; if (v !== undefined) value = v; if (!entries.some(e => e.key === value)) value = entries[0]?.key ?? null; sync(); if (!pop.hidden) render(); return value; },
    get value() { return value; },
    entry() { return entries.find(e => e.key === value) || null; },
    setValue(v) { value = v; sync(); },
  };
}
