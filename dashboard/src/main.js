import './style.css';
import './layout.js';
import { csv, pct, signed, escapeHTML, table } from './data.js';
import { initMap, setUnit, setMeasure, setReference, initialMeasure } from './map.js';
import { initChart, renderChart, setScenario } from './chart.js';
import { setBaselines, selectPlace, setShadeHandler, highlightShade } from './details.js';

const $ = selector => document.querySelector(selector);
const measure = $('#measure');
const dialog = $('#methods-dialog');
const methods = () => dialog.showModal();
for (const button of ['#methods-button','#status-button','#footer-methods']) $(button).addEventListener('click', methods);
$('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

for (const button of document.querySelectorAll('[data-unit]')) button.addEventListener('click', () => setUnit(button.dataset.unit));
let scenarioRows = [];
// When a scenario map is shown, the headline's range card states that scenario's statewide outcome from scenarios.csv.
function showScenario(key) {
  const name = { scen_paxton_p95_2p:'paxton_p95', scen_talarico_p95_2p:'talarico_p95' }[key];
  const row = name && scenarioRows.find(r => r.scenario === name);
  const low = scenarioRows.find(r => r.scenario === 'paxton_p95'), high = scenarioRows.find(r => r.scenario === 'talarico_p95');
  const range = low && high ? `${(100 * low.talarico_2p).toFixed(1)}–${pct(high.talarico_2p)}` : 'n/a';
  $('#range-card').classList.toggle('scenario-active', !!row);
  if (row) {
    $('#range-label').textContent = `map scenario, ${name === 'talarico_p95' ? 'Talarico' : 'Paxton'} best case:`;
    $('#range-value').textContent = pct(row.talarico_2p);
    $('#range-card').title = `Statewide Talarico two-party share at the ${name === 'talarico_p95' ? '95th' : '5th'} percentile · full range ${range}`;
  } else {
    $('#range-label').textContent = 'range';
    $('#range-value').textContent = range;
    $('#range-card').title = '5th–95th percentile of statewide share';
  }
}

async function applyMeasure(key, meta) {
  showScenario(key);
  try {
    await setMeasure(key, meta);
    if ($('#map-message').textContent.startsWith('Could not shade')) $('#map-message').hidden = true;
    renderChart(key);
    highlightShade(key);
  } catch (error) {
    console.error(error);
    $('#map-message').textContent = `Could not shade by this measure: ${error.message}`;
    $('#map-message').hidden = false;
  }
}
measure.addEventListener('change', () => applyMeasure(measure.value));
setShadeHandler(meta => {
  if (![...measure.options].some(option => option.value === meta.key)) {
    let group = measure.querySelector('#selected-measures');
    if (!group) {
      group = document.createElement('optgroup');
      group.id = 'selected-measures';
      group.label = 'Selected-place measures';
      measure.append(group);
    }
    group.replaceChildren(new Option(meta.label,meta.key));
  }
  measure.value = meta.key;
  applyMeasure(meta.key, meta);
});

try {
  initMap(selectPlace);
} catch (error) {
  console.error('Map initialization failed:', error);
  $('#map-message').textContent = 'This browser could not display the map. The forecast and polling data remain available.';
  $('#map-theme').disabled = true;
  $('#reset-map').disabled = true;
}

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
  $('#share-sub').textContent = `±${(100 * combined.sd).toFixed(1)}`;
  $('#win-value').textContent = pct(combined.p_talarico_win,0);
  scenarioRows = scenarios;
  showScenario(measure.value);
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

const shortLabels = { sen24:'2024 Senate', pres24:'2024 President', gov22:'2022 Governor', sen20:'2020 Senate', pres20:'2020 President', sen18:'2018 Senate', gov18:'2018 Governor', pres16:'2016 President' };

function renderShifts(shifts) {
  const combined = shifts.filter(row => row.component === 'combined').sort((a,b) => +(b.baseline === 'sen24') - +(a.baseline === 'sen24') || b.baseline.localeCompare(a.baseline));
  $('#shift-table').innerHTML = table(['Baseline','D two-party','Shift','90% interval'], combined.map(row => [
    row.label + (row.model_internal === 'TRUE' ? ' (reference baseline)' : ''), pct(row.baseline_2p), signed(row.shift_mean),
    `${signed(row.shift_q05)} to ${signed(row.shift_q95)}`,
  ]));
  optionGroup('2024 actual result', [['base_pres24','Harris two-party share'], ['dem_pres24','Harris votes']]);
  optionGroup('Shift from prior election', combined.map(row => [`shift_${row.baseline}`,`Shift vs ${shortLabels[row.baseline] || row.label}`]));
  optionGroup('Scenario maps', [['scen_paxton_p95_2p','Paxton best case (5th pct.)'], ['scen_talarico_p95_2p','Talarico best case (95th pct.)']]);
}

const shortDate = value => new Intl.DateTimeFormat('en-US',{ timeZone:'UTC', month:'short', day:'numeric' }).format(new Date(`${value}T00:00:00Z`));

function renderLedger(rows) {
  const sorted = [...rows].sort((a,b) => b.end_date.localeCompare(a.end_date));
  const body = sorted.map((row, i) => `<tr>
      <td class="pollster" title="${escapeHTML(row.pollster)}">${escapeHTML(row.pollster)}</td><td>${escapeHTML(shortDate(row.end_date))}</td><td>${escapeHTML(row.n)}</td>
      <td>${escapeHTML(row.talarico)}</td><td>${escapeHTML(row.paxton)}</td><td>${escapeHTML(pct(row.talarico_2p))}</td>
      <td><button type="button" class="row-expand" aria-expanded="false" aria-controls="poll-more-${i}" aria-label="More about ${escapeHTML(row.pollster)} poll">▸</button></td></tr>
    <tr id="poll-more-${i}" class="poll-more" hidden><td colspan="7">Other ${escapeHTML(row.other)}${row.brown_named === 'TRUE' ? ' · Brown named' : ''} · relative weight ${escapeHTML(pct(row.weight))} · source: ${escapeHTML(row.source)}</td></tr>`).join('');
  $('#poll-ledger').innerHTML = `<table class="ledger"><colgroup><col><col class="c-date"><col class="c-n"><col class="c-num"><col class="c-num"><col class="c-2p"><col class="c-x"></colgroup>
    <thead><tr><th>Pollster</th><th>End</th><th>n</th><th title="Talarico">Tal.</th><th title="Paxton">Pax.</th><th title="Talarico two-party share">2-pty</th><th><span class="visually-hidden">Details</span></th></tr></thead><tbody>${body}</tbody></table>`;
  $('#poll-ledger').addEventListener('click', event => {
    const button = event.target.closest('.row-expand');
    if (!button) return;
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? '▾' : '▸';
    document.getElementById(button.getAttribute('aria-controls')).hidden = !open;
  });
}

// The Texas-approval scenario is a layer on the chart, never a replacement for the forecast. A missing file leaves the layer without its label.
async function loadScenario() {
  let rows;
  try { rows = await csv('sensitivities.csv'); } catch { return; }
  if (!rows.length || !['adopted','p_talarico_win'].every(c => rows.columns.includes(c))) return;
  setScenario(rows.find(row => String(row.adopted).toUpperCase() !== 'TRUE'));
}

try {
  const [headline,track,ledger,gates,shifts,scenarios] = await Promise.all([
    'headline.csv','kalman_track.csv','poll_ledger.csv','gates.csv','uniform_shift.csv','scenarios.csv',
  ].map(csv));
  renderSummary(headline,scenarios,gates);
  renderShifts(shifts);
  setReference(headline, shifts, shortLabels);
  const requested = initialMeasure();
  if (requested && requested !== measure.value && [...measure.options].some(option => option.value === requested)) {
    measure.value = requested;
    applyMeasure(requested);
  }
  renderLedger(ledger);
  setBaselines(shifts);
  initChart(track,ledger,headline,shifts);
  loadScenario();
} catch (error) {
  console.error(error);
  $('#run-date').textContent = 'Published data unavailable';
  $('#status-button').textContent = 'Data unavailable';
  $('#status-button').classList.add('fail');
  $('#trend-chart').innerHTML = `<p class="note">${escapeHTML(error.message)}</p>`;
}
