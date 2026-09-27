import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import { base, csv, pct, count, signed, escapeHTML } from './data.js';

const bounds = [[-106.65, 25.84], [-93.51, 36.5]];
const shareColors = ['#a64238','#ce6e5d','#ecd0c8','#d7e5e8','#75aab9','#286b87'];
const shiftColors = ['#a64238','#d7846f','#f2f0ea','#88b3be','#286b87'];
const countColors = ['#edf3f5','#c7dfe6','#9dc7d4','#68a3b9','#367b9a','#124d70'];
const shareStops = [0.2, 0.35, 0.4999, 0.5, 0.65, 0.8];
const shiftStops = [-.15, -.075, 0, .075, .15];
const probStops = [0, .2, .4, .6, .8, 1];
const message = document.querySelector('#map-message');
const tooltip = document.querySelector('#map-tooltip');
const legend = document.querySelector('#legend');
let map, unit = 'county', measure = 'mean', onSelect = () => {};
let measureRequest = 0;
const metricKinds = new Map();
const scales = new Map();

const style = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const tileURL = name => `pmtiles://${new URL(`${base}${name}.pmtiles`, location.href).href}`;
const layerName = level => `${level}-fill`;
const isShift = key => key.startsWith('shift_');
const isCount = key => key === 'dem_pres24';
const sourceKey = key => key === 'result_confidence' ? 'p_talarico' : key === 'vote_density' ? 'ballots_per_sqmi' : key;
const boundedValue = v => Math.min(1, Math.max(0, +v));
const compact = (v, kind) => `${kind === 'money' ? '$' : ''}${Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:1 }).format(v)}`;

function quantileScale(rows, key, kind) {
  const values = rows.filter(row => row[key] !== '' && row[key] != null).map(row => +row[key]).filter(Number.isFinite).sort((a,b) => a-b);
  if (!values.length) throw new Error(`No map values for ${key}`);
  const stops = [0,.2,.4,.6,.8,1].map(q => values[Math.floor(q * (values.length-1))]);
  const labels = stops.map(v => compact(v, kind));
  for (let i=1; i<stops.length; i++) if (stops[i] <= stops[i-1]) stops[i] = stops[i-1] + .0001;
  return { stops, colors:countColors, labels };
}

function densityScale(rows) {
  const stops = rows.map(row => +row.value);
  const labels = stops.map(v => Intl.NumberFormat('en-US',{ notation:'compact',maximumFractionDigits:1 }).format(v));
  for (let i=1; i<stops.length; i++) if (stops[i] <= stops[i-1]) stops[i] = stops[i-1] + .0001;
  return { stops, colors:countColors, labels };
}

function scale(key, level = unit) {
  if (scales.has(key)) return scales.get(key)[level];
  if (key === 'result_confidence') return { stops:probStops, colors:shareColors, labels:['Paxton 100%','50%','Talarico 100%'] };
  if (metricKinds.get(key) === 'bounded') return { stops:probStops, colors:shareColors, labels:['0%','20%','40%','60%','80%','100%'] };
  if (isCount(key)) return level === 'county'
    ? { stops:[0,350,1300,5500,28000,150000], colors:countColors, labels:['0','350','1.3k','5.5k','28k','150k+'] }
    : { stops:[0,100,350,750,1200,2000], colors:countColors, labels:['0','100','350','750','1.2k','2k+'] };
  if (isShift(key)) return { stops: shiftStops, colors: shiftColors, labels: ['−15','−7.5','0','+7.5','+15'], suffix: 'two-party points' };
  if (key === 'p_talarico') return { stops: probStops, colors: shareColors, labels: ['0%','20%','40%','60%','80%','100%'], suffix: 'probability' };
  return { stops: shareStops, colors: shareColors, labels: ['20%','35%','50%','65%','80%'], suffix: 'two-party share' };
}

function colorExpression(key, level) {
  const { stops, colors } = scale(key, level);
  const column = sourceKey(key);
  const value = metricKinds.get(key) === 'bounded'
    ? ['min', 1, ['max', 0, ['to-number', ['get', column]]]]
    : ['to-number', ['get', column]];
  const interpolation = ['interpolate', ['linear'], value, ...stops.flatMap((stop, i) => [stop, colors[i]])];
  return ['case', ['has', column], interpolation, '#afb8b8'];
}

function drawLegend() {
  const s = scale(measure, unit);
  const select = document.querySelector('#measure');
  const title = select.selectedOptions[0]?.textContent || 'Projected share';
  const kind = metricKinds.get(measure);
  legend.innerHTML = `<div class="legend-title">${escapeHTML(title)}${measure === 'base_pres24' || isCount(measure) ? ' · 2024 actual' : ''}</div><div class="legend-ramp">${s.colors.map(color => `<span style="background:${color}"></span>`).join('')}</div><div class="legend-labels">${s.labels.map(label => `<span>${escapeHTML(label)}</span>`).join('')}</div>${measure === 'result_confidence' ? '<div class="legend-note">Color indicates the favored candidate; intensity indicates model probability.</div>' : measure === 'vote_density' ? '<div class="legend-note">Projected ballots per square mile · quantile scale</div>' : isShift(measure) ? '<div class="legend-note">Grey: no baseline for this place</div>' : kind === 'bounded' ? '<div class="legend-note">Estimated shares capped at 100% for shading.</div>' : kind === 'count' || kind === 'money' || isCount(measure) ? '<div class="legend-note">Counts reflect population as well as preference.</div>' : ''}`;
}

function valueText(props) {
  const v = props[sourceKey(measure)];
  const kind = metricKinds.get(measure);
  if (measure === 'result_confidence') return +v === .5 ? 'Even (50%)' : `${+v > .5 ? 'Talarico' : 'Paxton'} favored · ${pct(Math.max(+v,1 - +v))}`;
  if (measure === 'vote_density') return `${count(v)} ballots / sq mi`;
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
    for (const level of ['county','precinct']) map.setLayoutProperty(layerName(level), 'visibility', level === unit ? 'visible' : 'none');
  }
  drawLegend();
  tooltip.hidden = true;
}

export async function setMeasure(next, meta) {
  const request = ++measureRequest;
  measure = next;
  if (meta) metricKinds.set(next, meta.kind);
  if (((meta && ['count','money'].includes(meta.kind)) || next === 'dem_pres24') && !scales.has(next)) {
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

export function initMap(select) {
  onSelect = select;
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  map = new maplibregl.Map({ container:'map', style, bounds, fitBoundsOptions: { padding: 28 }, attributionControl: false, cooperativeGestures: false });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('load', () => {
    for (const level of ['county','precinct']) {
      map.addSource(level, { type:'vector', url:tileURL(level === 'county' ? 'counties' : 'regions'), promoteId:'region_id' });
      map.addLayer({ id:layerName(level), type:'fill', source:level, 'source-layer':'regions', layout:{ visibility:level === unit ? 'visible' : 'none' }, paint:{ 'fill-color':colorExpression(measure, level), 'fill-opacity':.83, 'fill-outline-color':'rgba(40,60,65,.28)' } });
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
  drawLegend();
  return map;
}
