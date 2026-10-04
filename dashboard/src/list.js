import { base, csv, pct, count, signed, escapeHTML } from './data.js';
import { countyNames, shortLabel } from './labels.js';
import { viewBounds } from './map.js';

const levels = {
  county:{ label:'Counties', details:'county_details.csv', projections:'county_projections.csv' },
  precinct:{ label:'Precincts', details:'precinct_details.csv', projections:'regional_projections.csv' },
  cd:{ label:'Congressional districts', details:'cd_details.csv', projections:'cd_projections.csv' },
  cousub:{ label:'County subdivisions', details:'cousub_details.csv', projections:'cousub_projections.csv' },
};
const valid = v => v !== '' && v != null && Number.isFinite(+v);
const cap = v => valid(v) ? `${pct(Math.min(1, Math.max(0, +v)))}${+v > 1 || +v < 0 ? ' (capped)' : ''}` : 'n/a';
// Values are published fields. Caps affect display only; sorting uses the source values.
const columns = [
  { key:'display', label:'Place', text:true },
  { key:'population', label:'Population', show:count },
  { key:'hisp_cvap_share', label:'Hispanic share of citizen adults', show:cap, bounded:true },
  { key:'white_cvap_share', label:'White share of citizen adults', show:cap, bounded:true },
  { key:'black_cvap_share', label:'Black share of citizen adults', show:cap, bounded:true },
  { key:'ba_plus_share', label:"Bachelor's degree or higher", show:cap, bounded:true },
  { key:'med_income', label:'Average of precinct median incomes', show:v => valid(v) ? `$${count(v)}` : 'n/a' },
  { key:'registered_2024', label:'Registered voters, 2024', show:count },
  { key:'ballots_mean', label:'Projected 2026 ballots', show:count },
  { key:'mean', label:'Projected Talarico two-party share', show:pct },
  { key:'shift_sen24', label:'Shift vs 2024 Senate', show:signed },
  { key:'shift_pres24', label:'Shift vs 2024 President', show:signed },
];
const pageSize = 50;
const state = { level:'', sort:'population', metric:'population', dir:-1, query:'', inView:false, full:false, page:0, filters:[] };
const boxes = new Map();
const boxesFor = level => {
  if (!boxes.has(level)) boxes.set(level, fetch(`${base}data/bounds_${level}.json`).then(r => r.ok ? r.json() : null).catch(() => null));
  return boxes.get(level);
};
export const listFiltersByView = () => state.inView;
const loaded = new Map();
const requests = new WeakMap();
export function cancelList(host) {
  requests.set(host, (requests.get(host) || 0) + 1);
  clearTimeout(host._timer);
}

// Join by character region_id and select columns explicitly to avoid collisions.
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
const filterScale = key => key === 'mean' || key.endsWith('_share') || key.startsWith('shift_') ? 100 : 1;
const filterUnit = key => key.startsWith('shift_') ? 'pts' : filterScale(key) === 100 ? '%' : key === 'med_income' ? '$' : '';
function editFilters(level, onApply) {
  const draft = state.filters.map(f => ({ ...f }));
  const choices = columns.filter(c => !c.text);
  const label = c => c.key === 'med_income' && level === 'precinct' ? 'Median income' : c.label;
  const dialog = document.createElement('dialog');
  dialog.className = 'list-filter-dialog';
  dialog.innerHTML = `<form><div class="filter-heading"><h2>Filter places</h2><button type="button" class="filter-close" aria-label="Close filters">×</button></div>
    <p class="note">Places must match every range. Ranges use published values, including estimates above display caps. Missing values are excluded when a range is set.</p>
    <div class="filter-rows"></div><button type="button" class="filter-add">Add filter</button>
    <div class="filter-actions"><button type="button" class="filter-clear">Clear all</button><button type="button" class="filter-cancel">Cancel</button><button type="submit" class="filter-apply">Apply filters</button></div></form>`;
  const rows = dialog.querySelector('.filter-rows');
  const draw = () => {
    rows.innerHTML = draft.map((f, i) => `<fieldset class="filter-row" data-index="${i}"><legend>Filter ${i + 1}</legend>
      <label class="filter-field">Measure <select>${choices.filter(c => c.key === f.key || !draft.some(other => other.key === c.key)).map(c => `<option value="${c.key}"${c.key === f.key ? ' selected' : ''}>${escapeHTML(label(c))}</option>`).join('')}</select></label>
      <label>At least ${filterUnit(f.key)}<input type="number" step="any" data-bound="min" value="${f.min ?? ''}"></label>
      <label>At most ${filterUnit(f.key)}<input type="number" step="any" data-bound="max" value="${f.max ?? ''}"></label>
      <button type="button" class="filter-remove" aria-label="Remove filter ${i + 1}">Remove</button></fieldset>`).join('') || '<p class="note">No numeric filters. Add a measure to set its range.</p>';
    dialog.querySelector('.filter-add').disabled = draft.length >= choices.length;
    rows.querySelectorAll('select').forEach(select => select.addEventListener('change', event => {
      const i = +event.target.closest('[data-index]').dataset.index;
      draft[i] = { key:event.target.value, min:'', max:'' };
      draw();
      rows.querySelector(`[data-index="${i}"] select`).focus();
    }));
    rows.querySelectorAll('input').forEach(input => input.addEventListener('input', event => {
      const row = event.target.closest('[data-index]');
      draft[+row.dataset.index][event.target.dataset.bound] = event.target.value;
      row.querySelectorAll('input').forEach(el => el.setCustomValidity(''));
    }));
    rows.querySelectorAll('.filter-remove').forEach(button => button.addEventListener('click', event => {
      draft.splice(+event.target.closest('[data-index]').dataset.index, 1); draw(); dialog.querySelector('.filter-add').focus();
    }));
  };
  dialog.querySelector('.filter-add').addEventListener('click', () => {
    const key = [state.metric, ...choices.map(c => c.key)].find(key => !draft.some(f => f.key === key));
    if (key) { draft.push({ key, min:'', max:'' }); draw(); rows.lastElementChild.querySelector('select').focus(); }
  });
  dialog.querySelector('.filter-clear').addEventListener('click', () => { draft.length = 0; draw(); });
  dialog.querySelectorAll('.filter-close,.filter-cancel').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    for (let i = 0; i < draft.length; i++) {
      const f = draft[i];
      if (f.min !== '' && f.max !== '' && +f.min > +f.max) {
        const input = rows.querySelector(`[data-index="${i}"] [data-bound="max"]`);
        input.setCustomValidity('The upper bound must be at least the lower bound.'); input.reportValidity(); return;
      }
    }
    state.filters = draft.filter(f => f.min !== '' || f.max !== '').map(f => ({ ...f }));
    state.page = 0;
    dialog.close();
    onApply();
  });
  dialog.addEventListener('close', () => { dialog.remove(); document.querySelector('.list-filters')?.focus(); }, { once:true });
  document.body.append(dialog); draw(); dialog.showModal();
}
const matchesFilters = row => state.filters.every(f => {
  const v = row[f.key];
  return valid(v) && (f.min === '' || +v >= +f.min / filterScale(f.key)) && (f.max === '' || +v <= +f.max / filterScale(f.key));
});


export async function renderList(host, mapUnit, pick) {
  cancelList(host);
  const request = requests.get(host);
  const current = () => requests.get(host) === request;
  const level = listLevel(mapUnit);
  const label = c => c.key === 'med_income' && level === 'precinct' ? 'Median income' : c.label;
  host.innerHTML = `<p class="note">Loading ${escapeHTML(levels[level].label.toLowerCase())}…</p>`;
  let rows;
  try { rows = await load(level); } catch (error) {
    if (current()) host.innerHTML = `<p class="note">${escapeHTML(error.message)}</p>`;
    return;
  }
  if (!current()) return;
  let inView = null;
  let boundsUnavailable = false;
  if (state.inView) {
    const boxMap = await boxesFor(level);
    if (!current()) return;
    const view = viewBounds();
    boundsUnavailable = !view || !boxMap;
    if (!boundsUnavailable) inView = id => {
      const b = boxMap[id];
      return b && b[0] <= view[2] && b[2] >= view[0] && b[1] <= view[3] && b[3] >= view[1];
    };
  }
  const col = columns.find(c => c.key === state.sort) || columns[1];
  const metric = columns.find(c => c.key === state.metric) || columns[1];
  const needle = state.query.trim().toLowerCase();
  const shown = rows.filter(row => matchesFilters(row) && (!inView || inView(row.region_id)) && (!needle || `${row.display} ${row.region_label} ${row.region_id}`.toLowerCase().includes(needle)));
  const value = row => col.text ? row[col.key].toLowerCase() : valid(row[col.key]) ? +row[col.key] : null;
  shown.sort((a, b) => {
    const x = value(a), y = value(b);
    if (x === null || y === null) return x === y ? a.region_id.localeCompare(b.region_id) : x === null ? 1 : -1;
    return ((x < y ? -1 : x > y ? 1 : 0) * state.dir) || a.region_id.localeCompare(b.region_id);
  });
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  state.page = Math.min(state.page, pages - 1);
  const start = state.page * pageSize;
  const visible = shown.slice(start, start + pageSize);
  const displayed = state.full ? columns : [columns[0], metric];
  const head = displayed.map(c => `<th scope="col" class="${c.text ? 'name' : ''}" aria-sort="${c.key === col.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${c.key}" title="Sort by ${escapeHTML(label(c))}">${escapeHTML(label(c))}</button></th>`).join('');
  const cell = (row, c) => {
    const raw = row[c.key];
    const title = c.text ? row.region_label : c.bounded && valid(raw) && (+raw > 1 || +raw < 0) ? `Source estimate ${pct(raw)}; capped for display only` : '';
    return `<td class="${c.text ? 'name' : ''}"${title ? ` title="${escapeHTML(title)}"` : ''}>${escapeHTML(c.text ? raw : c.show(raw))}</td>`;
  };
  const body = visible.map(row => `<tr data-id="${escapeHTML(row.region_id)}" tabindex="0" aria-label="Open ${escapeHTML(row.display)} details">${displayed.map(c => cell(row, c)).join('')}</tr>`).join('');
  const levelOptions = [['', `Same as map (${levels[mapUnit].label.toLowerCase()})`], ...Object.entries(levels).map(([key, info]) => [key, info.label])];
  host.innerHTML = `<div class="list-controls">
      <label class="list-geography">List <select class="list-level">${levelOptions.map(([key, text]) => `<option value="${key}"${key === state.level ? ' selected' : ''}>${escapeHTML(text)}</option>`).join('')}</select></label>
      <input type="search" class="list-search" placeholder="Search name or code" value="${escapeHTML(state.query)}" aria-label="Search the list by name or code">
      <label class="list-measure">Compare <select class="list-metric">${columns.filter(c => !c.text).map(c => `<option value="${c.key}"${c.key === metric.key ? ' selected' : ''}>${escapeHTML(label(c))}</option>`).join('')}</select></label>
      <button type="button" class="list-direction" aria-label="Reverse sort by ${escapeHTML(label(col))}" title="${escapeHTML(label(col))}: ${col.text ? (state.dir > 0 ? 'A to Z' : 'Z to A') : (state.dir > 0 ? 'Lowest first' : 'Highest first')}">${col.text ? (state.dir > 0 ? 'A–Z' : 'Z–A') : (state.dir > 0 ? '↑' : '↓')}</button>
      <div class="list-options"><label class="list-view"><input type="checkbox" class="list-inview"${state.inView ? ' checked' : ''}> In map view</label><button type="button" class="list-filters" aria-haspopup="dialog">Filters${state.filters.length ? ` (${state.filters.length})` : ''}</button><button type="button" class="list-full" aria-pressed="${state.full}">Full table</button></div>
    </div>
    ${level === 'cd' ? '<p class="note list-disclaimer">U.S. Senate forecast within each district.</p>' : ''}
    ${boundsUnavailable ? '<p class="note">Map bounds unavailable; showing all matching places.</p>' : ''}
    <div class="list-scroll"><table class="place-list${state.full ? ' full' : ' compact'}"><thead><tr>${head}</tr></thead><tbody>${body || `<tr class="list-empty"><td colspan="${displayed.length}">No places match. Adjust the search, filters, or map view.</td></tr>`}</tbody></table></div>
    <div class="list-footer"><p class="note list-count" role="status">${shown.length ? `${count(start + 1)}–${count(start + visible.length)} of` : ''} ${count(shown.length)} ${escapeHTML(levels[level].label.toLowerCase())}</p>
      <nav class="list-pagination" aria-label="Place list pages">
        <button type="button" data-page="0" aria-label="First page"${state.page === 0 ? ' disabled' : ''}>«</button><button type="button" data-page="${state.page - 1}" aria-label="Previous page"${state.page === 0 ? ' disabled' : ''}>‹</button>
        <label>Page <input class="list-page" type="number" min="1" max="${pages}" value="${state.page + 1}" aria-label="Page number"> of ${count(pages)}</label>
        <button type="button" data-page="${state.page + 1}" aria-label="Next page"${state.page >= pages - 1 ? ' disabled' : ''}>›</button><button type="button" data-page="${pages - 1}" aria-label="Last page"${state.page >= pages - 1 ? ' disabled' : ''}>»</button>
      </nav></div>`;
  const redraw = (focus = '') => renderList(host, mapUnit, pick).then(() => {
    if (focus) host.querySelector(focus)?.focus();
  });
  const reset = () => { state.page = 0; };
  host.querySelector('.list-level').addEventListener('change', event => { state.level = event.target.value; reset(); redraw('.list-level'); });
  host.querySelector('.list-inview').addEventListener('change', event => { state.inView = event.target.checked; reset(); redraw('.list-inview'); });
  host.querySelector('.list-metric').addEventListener('change', event => { state.metric = state.sort = event.target.value; state.dir = -1; reset(); redraw('.list-metric'); });
  host.querySelector('.list-direction').addEventListener('click', () => { state.dir = -state.dir; reset(); redraw('.list-direction'); });
  host.querySelector('.list-filters').addEventListener('click', () => editFilters(level, () => redraw('.list-filters')));
  host.querySelector('.list-full').addEventListener('click', () => { state.full = !state.full; redraw('.list-full'); });
  host.querySelector('.list-search').addEventListener('input', event => {
    state.query = event.target.value;
    reset();
    clearTimeout(host._timer);
    host._timer = setTimeout(async () => {
      await renderList(host, mapUnit, pick);
      const box = host.querySelector('.list-search');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }, 180);
  });
  host.querySelector('thead').addEventListener('click', event => {
    const button = event.target.closest('[data-sort]');
    if (!button) return;
    const key = button.dataset.sort;
    if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'display' ? 1 : -1; }
    if (key !== 'display') state.metric = key;
    reset();
    redraw(`[data-sort="${key}"]`);
  });
  host.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { state.page = +button.dataset.page; redraw('.list-page'); }));
  host.querySelector('.list-page').addEventListener('change', event => {
    const page = +event.target.value;
    state.page = Number.isInteger(page) ? Math.max(0, Math.min(pages - 1, page - 1)) : state.page;
    redraw('.list-page');
  });
  const open = row => { const hit = rows.find(item => item.region_id === row.dataset.id); if (hit) { cancelList(host); pick(level, { ...hit.projection, region_id:hit.region_id, region_label:hit.region_label }); } };
  host.querySelector('tbody').addEventListener('click', event => { const row = event.target.closest('tr[data-id]'); if (row) open(row); });
  host.querySelector('tbody').addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('tr[data-id]')) { event.preventDefault(); open(event.target); }
  });
}
