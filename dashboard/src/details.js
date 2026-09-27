import { csv, pct, count, escapeHTML, table } from './data.js';

let bases = [];
let selected = 0;
const content = document.querySelector('#place-content');

export function setBaselines(shifts) {
  bases = shifts.filter(row => row.component === 'combined').sort((a,b) => +(b.baseline === 'sen24') - +(a.baseline === 'sen24') || b.baseline.localeCompare(a.baseline));
}

function section(title, headers, rows) {
  return `<h3>${escapeHTML(title)}</h3><div class="table-scroll">${table(headers, rows)}</div>`;
}

function renderPlace(unit, props, data) {
  const label = props.region_label || props.region_id;
  const value = k => data[k];
  const harris = +value('dem_pres24'), trump = +value('rep_pres24');
  const voteRows = [
    ['Ballots cast','ballots'], ['Talarico (D)','talarico'], ['Paxton (R)','paxton'],
  ].map(([name,key]) => [name,count(value(`${key}_mean`)),`${count(value(`${key}_q05`))}–${count(value(`${key}_q95`))}`]);
  voteRows.push(['Brown (L)',count(value('brown_mean')),'—']);
  const resultRows = bases.map(b => {
    const dem = +value(`dem_${b.baseline}`), rep = +value(`rep_${b.baseline}`);
    return [b.label,count(value(`dem_${b.baseline}`)),count(value(`rep_${b.baseline}`)),dem+rep > 0 ? pct(dem/(dem+rep)) : 'n/a'];
  });
  const demographics = [
    ['Population',count(value('population'))], ['Citizen voting-age population',count(value('cvap_total'))],
    ['Hispanic share of CVAP',pct(value('hisp_cvap_share'))], ['White share of CVAP',pct(value('white_cvap_share'))],
    ['Black share of CVAP',pct(value('black_cvap_share'))], ["Bachelor's degree or higher",pct(value('ba_plus_share'))],
    [unit === 'county' ? 'Average of precinct median incomes' : 'Median income', value('med_income') ? `$${count(value('med_income'))}` : 'n/a'],
    ['Registered voters, 2024',count(value('registered_2024'))], ['Voted in 2022',count(value('voted_2022'))],
  ];
  content.innerHTML = `<div class="place-kicker">${unit === 'county' ? 'County' : 'Precinct'}${data.profile ? ` · ${escapeHTML(data.profile)}` : ''}</div><h2>${escapeHTML(label)}</h2>
    <div class="place-lede"><div class="place-stat"><span>Talarico two-party share</span><strong>${pct(props.mean)}</strong></div><div class="place-stat"><span>90% interval</span><strong>${pct(props.q05)}–${pct(props.q95)}</strong></div></div>
    <p class="actual-result"><strong>2024 Harris:</strong> ${count(value('dem_pres24'))} actual votes · ${harris + trump > 0 ? pct(harris / (harris + trump)) : 'n/a'} two-party share</p>
    <p class="note">Chance Talarico leads here: ${pct(props.p_talarico)}.${String(data.demographics_imputed).toUpperCase() === 'TRUE' ? ' Demographics estimated from neighboring precincts.' : ''}</p>
    ${section('Projected 2026 votes',['','Mean','90% range'],voteRows)}
    <p class="note">Vote counts come from a separate simulation and may imply a two-party share differing from the map by up to about half a point.</p>
    ${section('Past results',['Race','D votes','R votes','D two-party'],resultRows)}
    ${section('Demographics',['Measure','Value'],demographics)}`;
}

export async function selectPlace(unit, props) {
  const request = ++selected;
  document.querySelector('#tab-place').click();
  content.innerHTML = `<div class="place-kicker">${escapeHTML(unit)}</div><h2>${escapeHTML(props.region_label || props.region_id)}</h2><p class="note">Loading details…</p>`;
  try {
    const rows = await csv(unit === 'county' ? 'county_details.csv' : 'precinct_details.csv');
    if (request !== selected) return;
    const data = rows.find(row => row.region_id === String(props.region_id));
    if (!data) throw new Error('No detail row for this place.');
    renderPlace(unit, props, data);
  } catch (e) {
    if (request === selected) content.innerHTML = `<h2>${escapeHTML(props.region_label || props.region_id)}</h2><p class="note">${escapeHTML(e.message)}</p>`;
  }
}
