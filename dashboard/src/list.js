import { base, csv, pct, count, signed, escapeHTML } from './data.js';
import { countyNames, shortLabel } from './labels.js';
import { viewBounds } from './map.js';

const levels = {
  county:{ label:'Counties', details:'county_details.csv', projections:'county_projections.csv' },
  precinct:{ label:'Precincts', details:'precinct_details.csv', projections:'regional_projections.csv' },
  cd:{ label:'Congressional districts', details:'cd_details.csv', projections:'cd_projections.csv' },
  cousub:{ label:'County subdivisions', details:'cousub_details.csv', projections:'cousub_projections.csv' },
};
const cap = v => pct(Math.min(1, Math.max(0, +v)));
// Every column is a published field as-is; sorting and formatting are the only things done here.
const columns = [
  { key:'display', label:'Place', text:true },
  { key:'population', label:'Population', show:count },
  { key:'hisp_cvap_share', label:'Hispanic share of citizen adults', show:cap },
  { key:'white_cvap_share', label:'White share of citizen adults', show:cap },
  { key:'black_cvap_share', label:'Black share of citizen adults', show:cap },
  { key:'ba_plus_share', label:"Bachelor's degree or higher", show:cap },
  { key:'med_income', label:'Median income', show:v => Number.isFinite(+v) && v !== '' ? `$${count(v)}` : 'n/a' },
  { key:'registered_2024', label:'Registered voters, 2024', show:count },
  { key:'ballots_mean', label:'Projected 2026 ballots', show:count },
  { key:'mean', label:'Talarico two-party share', show:pct },
  { key:'shift_sen24', label:'Shift vs 2024 Senate', show:signed },
  { key:'shift_pres24', label:'Shift vs 2024 President', show:signed },
];
const rowCap = 300;
const state = { level:'', sort:'population', dir:-1, query:'', inView:false };
const boxes = new Map();
const boxesFor = level => { if (!boxes.has(level)) boxes.set(level, fetch(`${base}data/bounds_${level}.json`).then(r => r.ok ? r.json() : null).catch(() => null)); return boxes.get(level); };
export const listFiltersByView = () => state.inView;
const loaded = new Map();

// Details and projections share only region_id; the columns used from each are named explicitly so nothing collides.
async function load(level) {
  if (!loaded.has(level)) {
    const info = levels[level];
    loaded.set(level, Promise.all([csv(info.details), csv(info.projections), countyNames()]).then(([details, projections, counties]) => {
      const byId = new Map(projections.map(row => [row.region_id, row]));
      return details.map(detail => {
        const p = byId.get(detail.region_id) || {};
        const full = p.region_label || detail.region_id;
        return { region_id:detail.region_id, region_label:full, display:shortLabel(level, full, counties), population:detail.population, hisp_cvap_share:detail.hisp_cvap_share, white_cvap_share:detail.white_cvap_share, black_cvap_share:detail.black_cvap_share, ba_plus_share:detail.ba_plus_share, med_income:detail.med_income, registered_2024:detail.registered_2024, ballots_mean:detail.ballots_mean, mean:p.mean, shift_sen24:p.shift_sen24, shift_pres24:p.shift_pres24, projection:p };
      });
    }).catch(error => { loaded.delete(level); throw error; }));
  }
  return loaded.get(level);
}

export const listLevel = mapUnit => state.level || mapUnit;

// Draws into `host`; `pick(level, projectionRow)` opens a place and `onLevel` reports a change of level.
export async function renderList(host, mapUnit, pick) {
  const level = listLevel(mapUnit);
  host.innerHTML = `<p class="note">Loading ${escapeHTML(levels[level].label.toLowerCase())}…</p>`;
  let rows;
  try { rows = await load(level); } catch (error) { host.innerHTML = `<p class="note">${escapeHTML(error.message)}</p>`; return; }
  let inView = null;
  if (state.inView) {
    const [view, boxMap] = [viewBounds(), await boxesFor(level)];
    if (view && boxMap) inView = id => { const b = boxMap[id]; return !b || (b[0] <= view[2] && b[2] >= view[0] && b[1] <= view[3] && b[3] >= view[1]); };
  }
  const col = columns.find(c => c.key === state.sort) || columns[1];
  const needle = state.query.trim().toLowerCase();
  const shown = rows.filter(row => (!inView || inView(row.region_id)) && (!needle || (row.display + ' ' + row.region_label).toLowerCase().includes(needle)));
  const value = row => col.text ? row[col.key].toLowerCase() : (row[col.key] === '' || row[col.key] == null || !Number.isFinite(+row[col.key]) ? null : +row[col.key]);
  shown.sort((a, b) => {
    const x = value(a), y = value(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * state.dir;
  });
  const visible = shown.slice(0, rowCap);
  const head = columns.map(c => `<th class="${c.text ? 'name' : ''}" aria-sort="${c.key === col.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${c.key}">${escapeHTML(c.label)}</button></th>`).join('');
  const body = visible.map(row => `<tr data-id="${escapeHTML(row.region_id)}" tabindex="0">${columns.map(c => `<td class="${c.text ? 'name' : ''}"${c.text ? ` title="${escapeHTML(row.region_label)}"` : ''}>${escapeHTML(c.text ? row[c.key] : c.show(row[c.key]))}</td>`).join('')}</tr>`).join('');
  const levelOptions = [['', `Same as map (${levels[mapUnit].label.toLowerCase()})`], ...Object.entries(levels).map(([key, info]) => [key, info.label])];
  host.innerHTML = `<div class="list-controls">
      <label>List <select class="list-level">${levelOptions.map(([key, text]) => `<option value="${key}"${key === state.level ? ' selected' : ''}>${escapeHTML(text)}</option>`).join('')}</select></label>
      <label class="list-view"><input type="checkbox" class="list-inview"${state.inView ? ' checked' : ''}> Only places in the map view</label>
      <input type="search" class="list-search" placeholder="Search by name or code" value="${escapeHTML(state.query)}" aria-label="Search the list by name">
    </div>
    <div class="list-scroll"><table class="place-list"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="note list-count">${shown.length > rowCap ? `Showing the first ${count(rowCap)} of ${count(shown.length)} by this sort. Search or sort to narrow.` : `${count(shown.length)} ${escapeHTML(levels[level].label.toLowerCase())}.`} Select a row for details.</p>`;
  host.querySelector('.list-level').addEventListener('change', event => { state.level = event.target.value; renderList(host, mapUnit, pick); });
  host.querySelector('.list-inview').addEventListener('change', event => { state.inView = event.target.checked; renderList(host, mapUnit, pick); });
  host.querySelector('.list-search').addEventListener('input', event => {
    state.query = event.target.value;
    clearTimeout(host._timer);
    host._timer = setTimeout(async () => { await renderList(host, mapUnit, pick); const box = host.querySelector('.list-search'); box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 180);
  });
  host.querySelector('thead').addEventListener('click', event => {
    const button = event.target.closest('[data-sort]');
    if (!button) return;
    const key = button.dataset.sort;
    if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'display' ? 1 : -1; }
    renderList(host, mapUnit, pick);
  });
  const open = row => { const hit = rows.find(item => item.region_id === row.dataset.id); if (hit) pick(level, { ...hit.projection, region_id:hit.region_id, region_label:hit.region_label }); };
  host.querySelector('tbody').addEventListener('click', event => { const row = event.target.closest('tr'); if (row) open(row); });
  host.querySelector('tbody').addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.matches('tr')) open(event.target); });
}
