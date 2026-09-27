import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { base, csv, pct, count, signed, escapeHTML } from './data.js';

const bounds = [[-106.65, 25.84], [-93.51, 36.5]];
const electionColors = {
  light:['#9f352f','#c86656','#e4ab9c','#efeee8','#b2d5dc','#609fb5','#1d6483'],
  dark:['#ee766e','#d97068','#b77976','#b9c3c4','#79b5c2','#4ab0ce','#26a2d5'],
};
const volumeColors = {
  light:['#edf4f2','#c6e4df','#90c9c3','#55a9ac','#2c7b8e','#184c6a'],
  dark:['#415467','#527187','#568fa6','#4aa8be','#37c2d0','#a5e4e3'],
};
const confidenceColors = {
  light:['#f0f0f2','#dcdce9','#bcbad8','#9897c2','#7072a7','#494d88'],
  dark:['#48505f','#616a80','#7f86a7','#a3a7cf','#c5c5e7','#e4e1fa'],
};
const shareStops = [0,.25,.4,.5,.6,.75,1];
const shiftStops = [-.15,-.08,-.03,0,.03,.08,.15];
const probStops = [0,.2,.4,.5,.6,.8,1];
const confidenceStops = [.5,.6,.7,.8,.9,1];
const message = document.querySelector('#map-message');
const tooltip = document.querySelector('#map-tooltip');
const legend = document.querySelector('#legend');
let map, unit = 'county', measure = 'mean', theme = 'light', onSelect = () => {};
let measureRequest = 0;
const metricKinds = new Map();
const scales = new Map();

const styles = {
  light:'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark:'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const tileURL = name => `pmtiles://${new URL(`${base}${name}.pmtiles`, location.href).href}`;
const layerName = level => `${level}-fill`;
const isShift = key => key.startsWith('shift_');
const isCount = key => key === 'dem_pres24';
const sourceKey = key => key === 'result_confidence' ? 'p_talarico' : key === 'vote_density' ? 'net_votes_per_sqmi' : key;
const boundedValue = v => Math.min(1, Math.max(0, +v));
const compact = (v, kind) => `${kind === 'money' ? '$' : ''}${Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1 }).format(v)}`;

function quantileScale(rows, key, kind) {
  const values = rows.filter(row => row[key] !== '' && row[key] != null).map(row => +row[key])
    .filter(Number.isFinite).map(v => kind === 'bounded' ? boundedValue(v) : v).sort((a,b) => a-b);
  if (!values.length) throw new Error(`No map values for ${key}`);
  const stops = [0,.2,.4,.6,.8,1].map(q => values[Math.floor(q * (values.length-1))]);
  const labels = stops.map(v => kind === 'bounded' ? pct(v) : compact(v, kind));
  for (let i=1; i<stops.length; i++) if (stops[i] <= stops[i-1]) stops[i] = stops[i-1] + .0001;
  return { stops, labels, quantiles:true };
}

function densityScale(rows) {
  const stops = rows.map(row => +row.value);
  const labels = [`−${compact(Math.abs(stops[0]))}`, '0', `+${compact(stops.at(-1))}`];
  for (let i=1; i<stops.length; i++) if (stops[i] <= stops[i-1]) stops[i] = stops[i-1] + .0001;
  return { stops, labels };
}

function scale(key, level = unit) {
  if (scales.has(key)) return { ...scales.get(key)[level], colors:key === 'vote_density' ? electionColors[theme] : volumeColors[theme] };
  if (key === 'result_confidence') return { stops:confidenceStops, colors:confidenceColors[theme], labels:['50%','60%','70%','80%','90%','100%'] };
  if (key === 'p_talarico') return { stops:probStops, colors:electionColors[theme], labels:['Paxton 100%','50%','Talarico 100%'] };
  if (isShift(key)) return { stops:shiftStops, colors:electionColors[theme], labels:['−15','0','+15'], suffix:'two-party points' };
  return { stops:shareStops, colors:electionColors[theme], labels:['0%','50%','100%'], suffix:'two-party share' };
}

function colorExpression(key, level) {
  const { stops, colors } = scale(key, level);
  const column = sourceKey(key);
  const probability = ['to-number', ['get', column]];
  const value = key === 'result_confidence'
    ? ['min', 1, ['max', probability, ['-', 1, probability]]]
    : metricKinds.get(key) === 'bounded'
    ? ['min', 1, ['max', 0, ['to-number', ['get', column]]]]
    : probability;
  const interpolation = ['interpolate', ['linear'], value, ...stops.flatMap((stop, i) => [stop, colors[i]])];
  return ['case', ['has', column], interpolation, '#afb8b8'];
}

function drawLegend() {
  const s = scale(measure, unit);
  const select = document.querySelector('#measure');
  const title = select.selectedOptions[0]?.textContent || 'Projected share';
  const kind = metricKinds.get(measure);
  const positions = s.stops.map((stop,i) => (s.quantiles ? 100 * i / (s.stops.length - 1) : 100 * (stop - s.stops[0]) / (s.stops.at(-1) - s.stops[0])).toFixed(2));
  const gradient = s.colors.map((color,i) => `${color} ${positions[i]}%`).join(',');
  legend.innerHTML = `<div class="legend-title">${escapeHTML(title)}${measure === 'base_pres24' || isCount(measure) ? ' · 2024 actual' : ''}</div><div class="legend-ramp" style="background:linear-gradient(90deg,${gradient})"></div><div class="legend-labels">${s.labels.map(label => `<span>${escapeHTML(label)}</span>`).join('')}</div>${measure === 'result_confidence' ? '<div class="legend-note">Stronger purple means higher confidence, regardless of candidate.</div>' : measure === 'vote_density' ? '<div class="legend-note">Net projected votes per square mile: Paxton ← 0 → Talarico. Color caps at the 95th percentile of absolute density.</div>' : isShift(measure) ? '<div class="legend-note">Two-party points; grey areas lack a baseline.</div>' : s.quantiles ? `<div class="legend-note">Percentile breaks within ${unit === 'county' ? 'counties' : 'precincts'}${kind === 'bounded' ? '; estimates capped at 100%' : ''}.</div>` : ''}`;
}

function valueText(props) {
  const v = props[sourceKey(measure)];
  const kind = metricKinds.get(measure);
  if (measure === 'result_confidence') return +v === .5 ? '50% · even' : `${pct(Math.min(1,Math.max(+v,1 - +v)))} · ${+v > .5 ? 'Talarico' : 'Paxton'} favored`;
  if (measure === 'vote_density') return `${+v >= 0 ? '+' : '−'}${compact(Math.abs(+v))} votes / sq mi (${+v >= 0 ? 'Talarico' : 'Paxton'} net)`;
  if (kind === 'bounded') return +v > 1 ? '100% (capped)' : pct(boundedValue(v));
  if (kind === 'money') return `$${count(v)}`;
  return kind === 'count' || isCount(measure) ? count(v) : isShift(measure) ? signed(v) : pct(v);
}

function showTooltip(event, props) {
  const label = props.region_label || props.region_id || 'Selected place';
  tooltip.innerHTML = `<strong>${escapeHTML(label)}</strong>${escapeHTML(document.querySelector('#measure').selectedOptions[0].textContent)}: ${escapeHTML(valueText(props))}<br>Projected share: ${escapeHTML(pct(props.mean))}<br>90% interval: ${escapeHTML(pct(props.q05))}–${escapeHTML(pct(props.q95))}<br><span class="note">Click for details</span>`;
  const rect = document.querySelector('.map-pane').getBoundingClientRect();
  let x = event.originalEvent.clientX - rect.left + 13;
  let y = event.originalEvent.clientY - rect.top + 13;
  x = Math.min(x, rect.width - 265);
  y = Math.min(y, rect.height - 125);
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
  tooltip.hidden = false;
}

export function setUnit(next) {
  unit = next;
  document.querySelectorAll('[data-unit]').forEach(button => {
    const active = button.dataset.unit === unit;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (map?.getLayer('county-fill')) {
    for (const level of ['county','precinct']) map.setLayoutProperty(layerName(level), 'visibility', level === 'county' || level === unit ? 'visible' : 'none');
  }
  drawLegend();
  tooltip.hidden = true;
}

export async function setMeasure(next, meta) {
  const request = ++measureRequest;
  measure = next;
  if (meta) metricKinds.set(next, meta.kind);
  if (((meta && ['count','money','bounded'].includes(meta.kind)) || next === 'dem_pres24') && !scales.has(next)) {
    const [county, precinct] = await Promise.all([csv('county_details.csv'),csv('precinct_details.csv')]);
    if (request !== measureRequest) return;
    const kind = meta?.kind || 'count';
    scales.set(next, { county:quantileScale(county,next,kind), precinct:quantileScale(precinct,next,kind) });
  }
  if (next === 'vote_density' && !scales.has(next)) {
    const [county, precinct] = await Promise.all([csv('county_density.csv'),csv('precinct_density.csv')]);
    if (request !== measureRequest) return;
    scales.set(next,{ county:densityScale(county), precinct:densityScale(precinct) });
  }
  if (request !== measureRequest) return;
  drawLegend();
  if (!map?.getLayer('county-fill')) return;
  for (const level of ['county','precinct']) map.setPaintProperty(layerName(level), 'fill-color', colorExpression(measure, level));
  tooltip.hidden = true;
}

export function setTheme(next) {
  if (!styles[next] || theme === next) return;
  theme = next;
  const button = document.querySelector('#map-theme');
  button.textContent = theme === 'light' ? 'Dark map' : 'Light map';
  button.setAttribute('aria-pressed', String(theme === 'dark'));
  document.querySelector('.map-pane').dataset.theme = theme;
  drawLegend();
  if (map) map.setStyle(styles[theme]);
}

export function initMap(select) {
  onSelect = select;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  map = new maplibregl.Map({ container:'map', style:styles[theme], bounds, fitBoundsOptions: { padding: 28 }, attributionControl: false, cooperativeGestures: false });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('style.load', () => {
    for (const level of ['county','precinct']) {
      map.addSource(level, { type:'vector', url:tileURL(level === 'county' ? 'counties' : 'regions'), promoteId:'region_id' });
      map.addLayer({ id:layerName(level), type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:level === 'county' || level === unit ? 'visible' : 'none' }, paint:{ 'fill-color':colorExpression(measure, level), 'fill-opacity':theme === 'dark' ? .9 : .87, 'fill-outline-color':theme === 'dark' ? 'rgba(240,247,247,.3)' : 'rgba(40,60,65,.3)' } });
    }
    message.hidden = true;
  });
  map.on('mousemove', e => {
    if (!map.getLayer(layerName(unit))) return;
    const features = map.queryRenderedFeatures(e.point, { layers:[layerName(unit)] });
    const feature = features[0];
    map.getCanvas().style.cursor = feature ? 'pointer' : '';
    if (feature) showTooltip(e, feature.properties);
    else tooltip.hidden = true;
  });
  map.on('mouseleave', () => { tooltip.hidden = true; });
  map.on('click', e => {
    if (!map.getLayer(layerName(unit))) return;
    const feature = map.queryRenderedFeatures(e.point, { layers:[layerName(unit)] })[0];
    if (feature) { tooltip.hidden = true; onSelect(unit, feature.properties); }
  });
  map.on('error', e => {
    const error = String(e.error?.message || e.error || '');
    if (/pmtiles|regions|counties|404|fetch/i.test(error)) {
      message.textContent = 'Map tiles could not be loaded. The other data remains available.';
      message.hidden = false;
    }
    console.error('Map error:', e.error);
  });
  document.querySelector('#reset-map').addEventListener('click', () => map.fitBounds(bounds, { padding: 28, duration: 450 }));
  document.querySelector('#map-theme').addEventListener('click', () => setTheme(theme === 'light' ? 'dark' : 'light'));
  drawLegend();
  return map;
}
