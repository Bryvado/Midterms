import './style.css';
import { csv, pct, signed, escapeHTML, table } from './data.js';
import { initMap, setUnit, setMeasure } from './map.js';
import { initChart, renderChart } from './chart.js';
import { setBaselines, selectPlace } from './details.js';

const $ = selector => document.querySelector(selector);
const measure = $('#measure');
const dialog = $('#methods-dialog');
const methods = () => dialog.showModal();
for (const button of ['#methods-button','#status-button','#footer-methods']) $(button).addEventListener('click', methods);
$('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

for (const button of document.querySelectorAll('[data-unit]')) button.addEventListener('click', () => setUnit(button.dataset.unit));
for (const tab of document.querySelectorAll('[role=tab]')) tab.addEventListener('click', () => {
  for (const item of document.querySelectorAll('[role=tab]')) item.setAttribute('aria-selected', String(item === tab));
  for (const panel of document.querySelectorAll('[role=tabpanel]')) panel.hidden = panel.id !== tab.getAttribute('aria-controls');
  if (tab.id === 'tab-trend') window.dispatchEvent(new Event('resize'));
});
measure.addEventListener('change', () => { setMeasure(measure.value); renderChart(measure.value); });

initMap(selectPlace);

function optionGroup(label, values) {
  const group = document.createElement('optgroup');
  group.label = label;
  values.forEach(([key,text]) => group.append(new Option(text,key)));
  measure.append(group);
}

function renderSummary(headline, scenarios, gates) {
  const combined = headline.find(row => row.component === 'combined');
  if (!combined) throw new Error('Combined headline estimate is missing.');
  $('#share-value').textContent = pct(combined.mean);
  $('#share-sub').textContent = `± ${pct(combined.sd)} model SD`;
  $('#win-value').textContent = pct(combined.p_talarico_win,0);
  const low = scenarios.find(row => row.scenario === 'paxton_p95');
  const high = scenarios.find(row => row.scenario === 'talarico_p95');
  $('#range-value').textContent = low && high ? `${pct(low.talarico_2p)}–${pct(high.talarico_2p)}` : 'n/a';
  $('#run-date').textContent = `Model run ${combined.run_date}`;
  const fails = gates.filter(row => row.status === 'FAIL').length;
  const ungated = gates.filter(row => row.status === 'UNGATED').length;
  const status = $('#status-button');
  status.textContent = fails ? `${fails} failed check${fails === 1 ? '' : 's'}` : ungated ? `${ungated} ungated checks` : 'Model checks passed';
  status.classList.toggle('fail', !!fails);
  status.classList.toggle('ok', !fails && !ungated);
  $('#gate-summary').textContent = `${gates.length - fails - ungated} passed · ${ungated} ungated · ${fails} failed. Ungated checks are disclosed assumptions or incomplete coverage, not a pass result.`;
  const order = { FAIL:0, UNGATED:1, PASS:2 };
  const sorted = [...gates].sort((a,b) => order[a.status] - order[b.status]);
  $('#gate-list').innerHTML = sorted.map(row => `<div class="gate ${row.status.toLowerCase()}"><b>${escapeHTML(row.status)}</b>${escapeHTML(row.gate.replaceAll('_',' '))}<br><span>${escapeHTML(row.detail)} · ${escapeHTML(row.affects)}</span></div>`).join('');
}

function renderShifts(shifts) {
  const combined = shifts.filter(row => row.component === 'combined').sort((a,b) => +(b.baseline === 'sen24') - +(a.baseline === 'sen24') || b.baseline.localeCompare(a.baseline));
  const shortLabels = { sen24:'2024 Senate', pres24:'2024 President', gov22:'2022 Governor', sen20:'2020 Senate', pres20:'2020 President', sen18:'2018 Senate', gov18:'2018 Governor', pres16:'2016 President' };
  $('#shift-table').innerHTML = table(['Baseline','D two-party','Shift','90% interval'], combined.map(row => [
    row.label + (row.model_internal === 'TRUE' ? ' (model baseline)' : ''), pct(row.baseline_2p), signed(row.shift_mean),
    `${signed(row.shift_q05)} to ${signed(row.shift_q95)}`,
  ]));
  optionGroup('2024 actual result', [['base_pres24','Harris two-party share'], ['dem_pres24','Harris votes']]);
  optionGroup('Shift from prior election', combined.map(row => [`shift_${row.baseline}`,`Shift vs ${shortLabels[row.baseline] || row.label}${row.model_internal === 'TRUE' ? ' (model)' : ''}`]));
  optionGroup('Scenario maps', [['scen_paxton_p95_2p','Paxton best case (5th pct.)'], ['scen_talarico_p95_2p','Talarico best case (95th pct.)']]);
}

function renderLedger(rows) {
  const sorted = [...rows].sort((a,b) => b.end_date.localeCompare(a.end_date));
  $('#poll-ledger').innerHTML = table(['Pollster','End','n','Talarico','Paxton','Other','Two-party','Weight','Source'], sorted.map(row => [
    row.pollster,row.end_date,row.n,row.talarico,row.paxton,row.other,pct(row.talarico_2p),pct(row.weight),row.source,
  ]));
}

try {
  const [headline,track,ledger,gates,shifts,scenarios] = await Promise.all([
    'headline.csv','kalman_track.csv','poll_ledger.csv','gates.csv','uniform_shift.csv','scenarios.csv',
  ].map(csv));
  renderSummary(headline,scenarios,gates);
  renderShifts(shifts);
  renderLedger(ledger);
  setBaselines(shifts);
  initChart(track,ledger,headline,shifts);
} catch (error) {
  console.error(error);
  $('#run-date').textContent = 'Published data unavailable';
  $('#status-button').textContent = 'Data unavailable';
  $('#status-button').classList.add('fail');
  $('#panel-trend').innerHTML = `<p class="note">${escapeHTML(error.message)}</p>`;
}
