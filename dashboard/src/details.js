import { csv, pct, count, escapeHTML } from './data.js';
import { openPanel } from './layout.js';
import { renderList, listFiltersByView, cancelList } from './list.js';
import { countyNames, shortLabel } from './labels.js';

const levelInfo = {
  county:{ file:'county_details.csv', kicker:'County' },
  precinct:{ file:'precinct_details.csv', kicker:'Precinct' },
  cd:{ file:'cd_details.csv', kicker:'Congressional district (2025 map)', note:'U.S. Senate forecast within each district — not a House forecast.' },
  cousub:{ file:'cousub_details.csv', kicker:'County subdivision' },
};
const splitNote = 'Precincts that cross these lines are divided by 2020 census block population.';
let bases = [];
let selected = 0;
let mapUnit = 'county';
let listShowing = true;
let activeShade = '';
let onShade = () => {};
const content = document.querySelector('#place-content');

export function setBaselines(shifts) {
  bases = shifts.filter(row => row.component === 'combined').sort((a,b) => +(b.baseline === 'sen24') - +(a.baseline === 'sen24') || b.baseline.localeCompare(a.baseline));
}

// With no place selected the panel lists places; the list's level follows the map unless the user picks another.
export function showList(unit = mapUnit) {
  mapUnit = unit;
  listShowing = true;
  selected++;
  renderList(content, mapUnit, (level, props) => { selectPlace(level, props); window.dispatchEvent(new CustomEvent('zoom-place', { detail:{ level, id:props.region_id } })); });
}
window.addEventListener('unit-change', event => { mapUnit = event.detail; if (listShowing) showList(); });
content.addEventListener('click', event => { if (event.target.closest('.back-to-list')) showList(); });
// With "Only places in the map view" on, the list follows the map as it moves, unless the search box is being typed in.
let moveTimer;
window.addEventListener('view-change', () => {
  if (!listShowing || !listFiltersByView()) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => { if (!document.activeElement?.matches?.('.list-search')) showList(); }, 250);
});
showList();

export function setShadeHandler(handler) { onShade = handler; }

export function highlightShade(key) {
  activeShade = key;
  content.querySelectorAll('[data-shade-key]').forEach(button => {
    const active = button.dataset.shadeKey === key;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

content.addEventListener('click', event => {
  const button = event.target.closest('[data-shade-key]');
  if (!button) return;
  highlightShade(button.dataset.shadeKey);
  onShade({ key:button.dataset.shadeKey, label:button.dataset.shadeLabel, kind:button.dataset.shadeKind });
});

function shade(key, label, kind, raw, display) {
  const valid = raw !== '' && raw != null && Number.isFinite(+raw);
  if (!valid) return 'n/a';
  const bounded = kind === 'bounded' && +raw > 1;
  const text = display ?? (kind === 'bounded' ? `${pct(Math.min(1,Math.max(0,+raw)))}${bounded ? ' (capped)' : ''}` : kind === 'share' ? pct(raw) : kind === 'money' ? `$${count(raw)}` : count(raw));
  const title = bounded ? `Source estimate ${pct(raw)}; capped at 100% for display` : `Shade map by ${label}`;
  return `<button type="button" class="shade-value${activeShade === key ? ' active' : ''}" aria-pressed="${activeShade === key}" data-shade-key="${escapeHTML(key)}" data-shade-label="${escapeHTML(label)}" data-shade-kind="${escapeHTML(kind)}" title="${escapeHTML(title)}">${escapeHTML(text)}</button>`;
}

function section(title, headers, rows) {
  return `<h3>${escapeHTML(title)}</h3><div class="table-scroll"><table><thead><tr>${headers.map(h => `<th>${escapeHTML(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderPlace(unit, props, data, counties) {
  const label = props.region_label || props.region_id;
  const heading = shortLabel(unit, label, counties, { keepCounty:true });
  const value = key => data[key];
  const harris = +value('dem_pres24'), trump = +value('rep_pres24');
  const voteRows = [['Ballots cast','ballots'],['Talarico (D)','talarico'],['Paxton (R)','paxton']].map(([name,key]) => [
    escapeHTML(name),
    shade(`${key}_mean`,`${name}: mean 2026 votes`,'count',value(`${key}_mean`)),
    `${shade(`${key}_q05`,`${name}: 5th percentile votes`,'count',value(`${key}_q05`))}–${shade(`${key}_q95`,`${name}: 95th percentile votes`,'count',value(`${key}_q95`))}`,
  ]);
  voteRows.push(['Brown (L)',shade('brown_mean','Brown: mean 2026 votes','count',value('brown_mean')),'—']);
  const resultRows = bases.map(b => {
    const race = b.label, key = b.baseline;
    const dem = +value(`dem_${key}`), rep = +value(`rep_${key}`);
    return [escapeHTML(race),
      shade(`dem_${key}`,`${race}: Democratic votes`,'count',value(`dem_${key}`)),
      shade(`rep_${key}`,`${race}: Republican votes`,'count',value(`rep_${key}`)),
      dem + rep > 0 ? shade(`base_${key}`,`${race}: Democratic two-party share`,'share',dem/(dem+rep)) : 'n/a'];
  });
  const demographics = [
    ['Population','population','count'],['Citizen voting-age population','cvap_total','count'],
    ['Hispanic share of CVAP','hisp_cvap_share','bounded'],['White share of CVAP','white_cvap_share','bounded'],
    ['Black share of CVAP','black_cvap_share','bounded'],["Bachelor's degree or higher",'ba_plus_share','bounded'],
    [unit === 'precinct' ? 'Median income' : 'Average of precinct median incomes','med_income','money'],
    ['Registered voters, 2024','registered_2024','count'],['Voted in 2022','voted_2022','count'],
  ].map(([name,key,kind]) => [escapeHTML(name),shade(key,name,kind,value(key))]);
  content.innerHTML = `<button type="button" class="back-to-list">Back to list</button><div class="place-kicker">${escapeHTML(levelInfo[unit].kicker)}${data.profile ? ` · ${escapeHTML(data.profile)}` : ''}</div><h2 title="${escapeHTML(label)}">${escapeHTML(heading)}</h2>${levelInfo[unit].note ? `<p class="level-disclaimer">${escapeHTML(levelInfo[unit].note)}</p>` : ''}${unit === 'cd' || unit === 'cousub' ? `<p class="note">${escapeHTML(splitNote)}</p>` : ''}
    <p class="shade-hint">Select any underlined number to shade the map by that measure.</p>
    <div class="place-lede"><div class="place-stat"><span>Talarico two-party share</span><strong>${shade('mean','Projected Talarico two-party share','share',props.mean)}</strong></div><div class="place-stat"><span>90% interval</span><strong>${shade('q05','Projected share: 5th percentile','share',props.q05)}–${shade('q95','Projected share: 95th percentile','share',props.q95)}</strong></div></div>
    <p class="actual-result"><strong>2024 Harris:</strong> ${shade('dem_pres24','2024 Harris votes','count',value('dem_pres24'))} actual votes · ${harris + trump > 0 ? shade('base_pres24','2024 Harris two-party share','share',harris/(harris+trump)) : 'n/a'} two-party share</p>
    <p class="note">Chance Talarico leads here: ${shade('p_talarico','Chance Talarico leads','share',props.p_talarico)}.${String(data.demographics_imputed).toUpperCase() === 'TRUE' ? ' Demographics estimated from neighboring precincts.' : ''}</p>
    ${section('Projected 2026 votes',['','Mean','90% range'],voteRows)}
    <p class="note">Vote counts come from a separate simulation and may imply a two-party share differing from the map by up to about half a point.</p>
    ${section('Past results',['Race','D votes','R votes','D two-party'],resultRows)}
    ${section('Demographics',['Measure','Value'],demographics)}
    <p class="note">Estimated percentage fields are capped at 100% for display and map shading. The published source values remain unchanged.</p>`;
}

export async function selectPlace(unit, props) {
  cancelList(content);
  const request = ++selected;
  listShowing = false;
  openPanel('place');
  content.innerHTML = `<div class="place-kicker">${escapeHTML(levelInfo[unit]?.kicker || unit)}</div><h2>${escapeHTML(props.region_label || props.region_id)}</h2><p class="note">Loading details…</p>`;
  try {
    const rows = await csv(levelInfo[unit].file);
    if (request !== selected) return;
    const data = rows.find(row => row.region_id === String(props.region_id));
    if (!data) throw new Error('No detail row for this place.');
    renderPlace(unit, props, data, await countyNames());
  } catch (e) {
    if (request === selected) content.innerHTML = `<h2>${escapeHTML(props.region_label || props.region_id)}</h2><p class="note">${escapeHTML(e.message)}</p>`;
  }
}
